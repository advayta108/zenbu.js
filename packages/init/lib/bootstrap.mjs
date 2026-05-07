import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import https from "node:https";
import { execFileSync, spawn } from "node:child_process";

const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "Zenbu");
const BIN_DIR = path.join(CACHE_ROOT, "bin");
const BUN_BIN = path.join(BIN_DIR, "bun");
const BUN_VERSION_MARKER = path.join(BIN_DIR, ".bun.version");

const BOOTSTRAP_BUN = {
  version: "1.3.12",
  targets: {
    "darwin-aarch64": {
      asset: "bun-darwin-aarch64.zip",
      sha256:
        "6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c",
    },
    "darwin-x64": {
      asset: "bun-darwin-x64.zip",
      sha256:
        "0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d",
    },
  },
};

function detectBunTarget() {
  const arch = os.arch();
  if (arch === "arm64") return "darwin-aarch64";
  if (arch === "x64") return "darwin-x64";
  throw new Error(`unsupported architecture: ${arch}`);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        res.resume();
        return;
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function findBunBinary(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findBunBinary(full);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === "bun") {
      return full;
    }
  }
  return null;
}

export async function ensureBunBootstrapped() {
  if (fs.existsSync(BUN_BIN)) {
    console.log(`  ✓ bun already installed at ${BUN_BIN}`);
    return;
  }

  const target = detectBunTarget();
  const { asset, sha256: expectedSha } = BOOTSTRAP_BUN.targets[target];
  const tag = `bun-v${BOOTSTRAP_BUN.version}`;
  const url = `https://github.com/oven-sh/bun/releases/download/${tag}/${asset}`;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenbu-bun-"));
  const zipPath = path.join(tmpDir, asset);

  console.log(`  → downloading bun ${BOOTSTRAP_BUN.version}`);
  await downloadFile(url, zipPath);

  const actualSha = await sha256(zipPath);
  if (actualSha !== expectedSha) {
    throw new Error(
      `bun sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }

  console.log(`  → unpacking`);
  execFileSync("unzip", ["-q", asset], { cwd: tmpDir });

  const extracted = findBunBinary(tmpDir);
  if (!extracted) {
    throw new Error("could not locate bun binary in downloaded archive");
  }
  fs.copyFileSync(extracted, BUN_BIN);
  fs.chmodSync(BUN_BIN, 0o755);
  fs.writeFileSync(BUN_VERSION_MARKER, BOOTSTRAP_BUN.version);

  const nodeLink = path.join(BIN_DIR, "node");
  try { fs.unlinkSync(nodeLink); } catch {}
  fs.symlinkSync("bun", nodeLink);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`  ✓ bun ${BOOTSTRAP_BUN.version} installed`);
}

export function runCommand(cmd, args, cwd, { env: extraEnv = {}, silent = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: silent ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      env: { ...process.env, FORCE_COLOR: "0", ...extraEnv },
    });
    if (silent) {
      proc.stdout?.resume();
      proc.stderr?.resume();
    }
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

export { BUN_BIN, BIN_DIR, CACHE_ROOT };
