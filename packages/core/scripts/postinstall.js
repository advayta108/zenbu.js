#!/usr/bin/env node
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
const versionsPath = path.join(packageDir, "setup", "versions.json");
const targetRoot = process.env.ZENBU_TOOLCHAIN_STAGING_ROOT
  ? path.resolve(process.env.ZENBU_TOOLCHAIN_STAGING_ROOT)
  : null;

function cacheRoot() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "Zenbu");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Zenbu");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "Zenbu");
}

const root = targetRoot ?? cacheRoot();
const binDir = path.join(root, "bin");

function log(message) {
  console.log(`[zenbujs/core] ${message}`);
}

function readMarker(name) {
  try {
    return fs.readFileSync(path.join(binDir, `.${name}.version`), "utf8").trim();
  } catch {
    return "";
  }
}

function writeMarker(name, version) {
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

async function ensureBun(versions) {
  const target = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x64";
  const info = versions.bun.targets[target];
  if (!info) throw new Error(`unsupported bun target: ${target}`);
  const bunBin = path.join(binDir, "bun");
  if (fs.existsSync(bunBin) && readMarker("bun") === versions.bun.version) {
    await ensureNodeSymlink();
    return;
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-bun-"));
  const zipPath = path.join(tmp, info.asset);
  const url = `https://github.com/oven-sh/bun/releases/download/${versions.bun.releaseTag}/${info.asset}`;
  log(`downloading bun ${versions.bun.version}`);
  await download(url, zipPath);
  await verify(zipPath, info.sha256);
  await execFileAsync("unzip", ["-q", zipPath, "-d", tmp]);
  const extracted = await findExecutable(tmp, "bun");
  if (!extracted) throw new Error(`could not find bun in ${info.asset}`);
  await fsp.copyFile(extracted, bunBin);
  await fsp.chmod(bunBin, 0o755);
  writeMarker("bun", versions.bun.version);
  await ensureNodeSymlink();
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function ensureNodeSymlink() {
  const nodePath = path.join(binDir, "node");
  try {
    await fsp.unlink(nodePath);
  } catch {}
  await fsp.symlink("bun", nodePath);
}

async function ensurePnpm(versions) {
  const target = `darwin-${archSuffix()}`;
  const info = versions.pnpm.targets[target];
  if (!info) throw new Error(`unsupported pnpm target: ${target}`);
  const pnpmBin = path.join(binDir, "pnpm");
  if (fs.existsSync(pnpmBin) && readMarker("pnpm") === versions.pnpm.version) return;

  const tmp = path.join(binDir, ".pnpm.download");
  const url = `https://github.com/pnpm/pnpm/releases/download/${versions.pnpm.releaseTag}/${info.asset}`;
  log(`downloading pnpm ${versions.pnpm.version}`);
  await download(url, tmp);
  await verify(tmp, info.sha256);
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, pnpmBin);
  writeMarker("pnpm", versions.pnpm.version);
}

async function ensureGit(versions) {
  const target = `darwin-${archSuffix()}`;
  const info = versions.git.targets[target];
  if (!info) throw new Error(`unsupported git target: ${target}`);
  const gitRoot = path.join(root, "git");
  const gitLink = path.join(binDir, "git");
  if (fs.existsSync(gitLink) && readMarker("git") === versions.git.version) return;

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-git-"));
  const archivePath = path.join(tmp, "git.tar.gz");
  log(`downloading dugite-native git ${versions.git.version}`);
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
  writeMarker("git", versions.git.version);
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function main() {
  if (process.env.ZENBU_SKIP_TOOLCHAIN_POSTINSTALL === "1") return;
  if (process.platform !== "darwin") {
    log(`toolchain postinstall skipped on ${process.platform}; only macOS targets exist today`);
    return;
  }
  if (targetRoot) log(`provisioning toolchain into ${root}`);
  await fsp.mkdir(binDir, { recursive: true });
  const versions = JSON.parse(await fsp.readFile(versionsPath, "utf8"));
  await ensureBun(versions);
  await ensurePnpm(versions);
  await ensureGit(versions);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
