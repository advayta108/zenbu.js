import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Hardcoded bun + pnpm versions that the .app bundles for its first-launch
 * `pnpm install`. We download these from upstream releases on demand (cached
 * globally per-version), verify against pinned sha256, and stage them into
 * the build's `extraResources/toolchain/` directory.
 *
 * Bumping a version: update the entry, paste the upstream release tarball's
 * sha256, and the next `zen build:electron` will re-fetch into a new cache
 * directory automatically.
 *
 * Currently darwin-only — Linux/Windows support is a future-PR concern.
 */
const TOOLCHAIN = {
  bun: {
    version: "1.3.12",
    releaseTag: "bun-v1.3.12",
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
  },
  pnpm: {
    version: "10.33.0",
    releaseTag: "v10.33.0",
    targets: {
      "darwin-arm64": {
        asset: "pnpm-macos-arm64",
        sha256:
          "ed8a1f140f4de457b01ebe0be3ae28e9a7e28863315dcd53d22ff1e5a32d63ae",
      },
      "darwin-x64": {
        asset: "pnpm-macos-x64",
        sha256:
          "c31e29554b0e3f4e03f4617195c949595e4dca36085922003de4896c3ca4057d",
      },
    },
  },
} as const

export const PNPM_VERSION = TOOLCHAIN.pnpm.version
export const BUN_VERSION = TOOLCHAIN.bun.version

function cacheRoot(): string {
  return path.join(os.homedir(), ".zenbu", "cache", "toolchain")
}

function bunTarget(): "darwin-aarch64" | "darwin-x64" {
  if (process.arch === "arm64") return "darwin-aarch64"
  if (process.arch === "x64") return "darwin-x64"
  throw new Error(`zenbu toolchain: unsupported architecture ${process.arch}`)
}

function pnpmTarget(): "darwin-arm64" | "darwin-x64" {
  if (process.arch === "arm64") return "darwin-arm64"
  if (process.arch === "x64") return "darwin-x64"
  throw new Error(`zenbu toolchain: unsupported architecture ${process.arch}`)
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume()
        download(new URL(res.headers.location, url).href, dest).then(
          resolve,
          reject,
        )
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`))
        res.resume()
        return
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on("finish", () => out.close(() => resolve()))
      out.on("error", reject)
    })
    req.on("error", reject)
  })
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

async function verify(filePath: string, expected: string): Promise<void> {
  const actual = await sha256(filePath)
  if (actual !== expected) {
    throw new Error(
      `zenbu toolchain: sha256 mismatch for ${path.basename(filePath)} (expected ${expected}, got ${actual})`,
    )
  }
}

async function findExecutable(dir: string, name: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findExecutable(full, name)
      if (nested) return nested
    } else if (entry.isFile() && entry.name === name) {
      return full
    }
  }
  return null
}

async function ensureBunCached(): Promise<string> {
  const target = bunTarget()
  const info = TOOLCHAIN.bun.targets[target]
  const dir = path.join(cacheRoot(), `bun-${TOOLCHAIN.bun.version}-${target}`)
  const cached = path.join(dir, "bun")
  if (fs.existsSync(cached)) return cached

  await fsp.mkdir(dir, { recursive: true })
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-bun-"))
  try {
    const zipPath = path.join(tmp, info.asset)
    const url = `https://github.com/oven-sh/bun/releases/download/${TOOLCHAIN.bun.releaseTag}/${info.asset}`
    console.log(`  → downloading bun ${TOOLCHAIN.bun.version} (${target})`)
    await download(url, zipPath)
    await verify(zipPath, info.sha256)
    await execFileAsync("unzip", ["-q", zipPath, "-d", tmp])
    const extracted = await findExecutable(tmp, "bun")
    if (!extracted) {
      throw new Error(
        `zenbu toolchain: could not find bun in ${info.asset}`,
      )
    }
    await fsp.copyFile(extracted, cached)
    await fsp.chmod(cached, 0o755)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
  return cached
}

async function ensurePnpmCached(): Promise<string> {
  const target = pnpmTarget()
  const info = TOOLCHAIN.pnpm.targets[target]
  const dir = path.join(cacheRoot(), `pnpm-${TOOLCHAIN.pnpm.version}-${target}`)
  const cached = path.join(dir, "pnpm")
  if (fs.existsSync(cached)) return cached

  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, ".download")
  const url = `https://github.com/pnpm/pnpm/releases/download/${TOOLCHAIN.pnpm.releaseTag}/${info.asset}`
  console.log(`  → downloading pnpm ${TOOLCHAIN.pnpm.version} (${target})`)
  await download(url, tmp)
  await verify(tmp, info.sha256)
  await fsp.chmod(tmp, 0o755)
  await fsp.rename(tmp, cached)
  return cached
}

/**
 * Stage hardcoded bun + pnpm into `<stagingDir>/{bun, pnpm}` so the build
 * can wire them into electron-builder as extraResources. Returns absolute
 * paths to the staged binaries.
 *
 * The sibling `node` symlink (-> `bun`) is created so that any npm
 * lifecycle script that does `#!/usr/bin/env node` can resolve to bun
 * inside the launched .app.
 */
export async function provisionToolchain(stagingDir: string): Promise<{
  bun: string
  pnpm: string
  node: string
}> {
  if (process.platform !== "darwin") {
    throw new Error(
      `zenbu toolchain: only darwin is supported today (got ${process.platform})`,
    )
  }
  await fsp.mkdir(stagingDir, { recursive: true })

  const cachedBun = await ensureBunCached()
  const cachedPnpm = await ensurePnpmCached()

  const bunOut = path.join(stagingDir, "bun")
  const pnpmOut = path.join(stagingDir, "pnpm")
  const nodeOut = path.join(stagingDir, "node")

  await fsp.copyFile(cachedBun, bunOut)
  await fsp.chmod(bunOut, 0o755)
  await fsp.copyFile(cachedPnpm, pnpmOut)
  await fsp.chmod(pnpmOut, 0o755)
  try {
    await fsp.unlink(nodeOut)
  } catch {}
  await fsp.symlink("bun", nodeOut)

  return { bun: bunOut, pnpm: pnpmOut, node: nodeOut }
}
