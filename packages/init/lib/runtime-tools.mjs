import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionsPath = path.join(packageDir, "runtime-tools", "versions.json");

function log(message, silent) {
  if (!silent) console.log(`  ${message}`);
}

function readMarker(binDir, name) {
  try {
    return fs.readFileSync(path.join(binDir, `.${name}.version`), "utf8").trim();
  } catch {
    return "";
  }
}

function writeMarker(binDir, name, version) {
  fs.writeFileSync(path.join(binDir, `.${name}.version`), version);
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function verify(filePath, expected) {
  const actual = await sha256(filePath);
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
}

async function download(url, dest) {
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        download(new URL(response.headers.location, url).href, dest).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed with ${response.statusCode}`));
        response.resume();
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function findExecutable(dir, name) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return null;
}

function archSuffix() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`unsupported architecture: ${process.arch}`);
}

async function ensureNodeSymlink(binDir) {
  const nodePath = path.join(binDir, "node");
  try {
    await fsp.unlink(nodePath);
  } catch {}
  await fsp.symlink("bun", nodePath);
}

async function ensureBun(root, versions, silent) {
  const binDir = path.join(root, "bin");
  const target = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x64";
  const info = versions.bun.targets[target];
  if (!info) throw new Error(`unsupported bun target: ${target}`);
  const bunBin = path.join(binDir, "bun");
  if (fs.existsSync(bunBin) && readMarker(binDir, "bun") === versions.bun.version) {
    await ensureNodeSymlink(binDir);
    return;
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-bun-"));
  const zipPath = path.join(tmp, info.asset);
  const url = `https://github.com/oven-sh/bun/releases/download/${versions.bun.releaseTag}/${info.asset}`;
  log(`Downloading Bun ${versions.bun.version}`, silent);
  await download(url, zipPath);
  await verify(zipPath, info.sha256);
  await execFileAsync("unzip", ["-q", zipPath, "-d", tmp]);
  const extracted = await findExecutable(tmp, "bun");
  if (!extracted) throw new Error(`could not find bun in ${info.asset}`);
  await fsp.copyFile(extracted, bunBin);
  await fsp.chmod(bunBin, 0o755);
  writeMarker(binDir, "bun", versions.bun.version);
  await ensureNodeSymlink(binDir);
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function ensurePnpm(root, versions, silent) {
  const binDir = path.join(root, "bin");
  const target = `darwin-${archSuffix()}`;
  const info = versions.pnpm.targets[target];
  if (!info) throw new Error(`unsupported pnpm target: ${target}`);
  const pnpmBin = path.join(binDir, "pnpm");
  if (fs.existsSync(pnpmBin) && readMarker(binDir, "pnpm") === versions.pnpm.version) return;

  const tmp = path.join(binDir, ".pnpm.download");
  const url = `https://github.com/pnpm/pnpm/releases/download/${versions.pnpm.releaseTag}/${info.asset}`;
  log(`Downloading pnpm ${versions.pnpm.version}`, silent);
  await download(url, tmp);
  await verify(tmp, info.sha256);
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, pnpmBin);
  writeMarker(binDir, "pnpm", versions.pnpm.version);
}

async function ensureGit(root, versions, silent) {
  const binDir = path.join(root, "bin");
  const target = `darwin-${archSuffix()}`;
  const info = versions.git.targets[target];
  if (!info) throw new Error(`unsupported git target: ${target}`);
  const gitRoot = path.join(root, "git");
  const gitLink = path.join(binDir, "git");
  if (fs.existsSync(gitLink) && readMarker(binDir, "git") === versions.git.version) return;

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-git-"));
  const archivePath = path.join(tmp, "git.tar.gz");
  log(`Downloading Git ${versions.git.version}`, silent);
  await download(info.url, archivePath);
  await fsp.rm(gitRoot, { recursive: true, force: true });
  await fsp.mkdir(gitRoot, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", gitRoot]);
  const gitBin = await findExecutable(gitRoot, "git");
  if (!gitBin) throw new Error("could not find git in dugite-native archive");
  try {
    await fsp.unlink(gitLink);
  } catch {}
  await fsp.symlink(gitBin, gitLink);
  writeMarker(binDir, "git", versions.git.version);
  await fsp.rm(tmp, { recursive: true, force: true });
}

export async function ensureRuntimeTools(projectDir, { silent = false } = {}) {
  if (process.platform !== "darwin") {
    throw new Error(`Zenbu runtime tools only support macOS today (got ${process.platform})`);
  }
  const root = path.join(projectDir, ".zenbu", "toolchain");
  await fsp.mkdir(path.join(root, "bin"), { recursive: true });
  const versions = JSON.parse(await fsp.readFile(versionsPath, "utf8"));
  await ensureBun(root, versions, silent);
  await ensurePnpm(root, versions, silent);
  await ensureGit(root, versions, silent);
  return {
    root,
    binDir: path.join(root, "bin"),
    bun: path.join(root, "bin", "bun"),
    node: path.join(root, "bin", "node"),
    pnpm: path.join(root, "bin", "pnpm"),
    git: path.join(root, "bin", "git"),
  };
}
