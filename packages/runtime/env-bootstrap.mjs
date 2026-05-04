import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const INTERNAL_DIR = path.join(os.homedir(), ".zenbu", ".internal")
const PATHS_JSON = path.join(INTERNAL_DIR, "paths.json")

function userCacheRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches")
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
}

function computePaths() {
  const cacheRoot = path.join(userCacheRoot(), "Zenbu")
  const binDir = path.join(cacheRoot, "bin")
  return {
    cacheRoot,
    binDir,
    bunInstall: path.join(cacheRoot, "bun"),
    bunPath: path.join(binDir, "bun"),
    pnpmHome: path.join(cacheRoot, "pnpm"),
    pnpmPath: path.join(binDir, "pnpm"),
    xdgCacheHome: path.join(cacheRoot, "xdg", "cache"),
    xdgDataHome: path.join(cacheRoot, "xdg", "data"),
    xdgStateHome: path.join(cacheRoot, "xdg", "state"),
    writtenAt: Date.now(),
  }
}

function probeUserToolPaths() {
  const home = os.homedir()
  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".cargo", "bin"),
  ]
  const found = candidates.filter((p) => {
    try { return fs.statSync(p).isDirectory() } catch { return false }
  })
  try {
    const nvmDir = path.join(home, ".nvm", "versions", "node")
    if (fs.statSync(nvmDir).isDirectory()) {
      for (const v of fs.readdirSync(nvmDir)) {
        const bin = path.join(nvmDir, v, "bin")
        try { if (fs.statSync(bin).isDirectory()) found.push(bin) } catch {}
      }
    }
  } catch {}
  return found
}

export function bootstrapEnv() {
  const paths = computePaths()

  try { fs.mkdirSync(paths.binDir, { recursive: true }) } catch {}

  const toolchainReady =
    fs.existsSync(paths.bunPath) && fs.existsSync(paths.pnpmPath)

  if (toolchainReady) {
    if (!process.env.BUN_INSTALL) process.env.BUN_INSTALL = paths.bunInstall
    if (!process.env.PNPM_HOME) process.env.PNPM_HOME = paths.pnpmHome
    if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = paths.xdgCacheHome
    if (!process.env.XDG_DATA_HOME) process.env.XDG_DATA_HOME = paths.xdgDataHome
    if (!process.env.XDG_STATE_HOME) process.env.XDG_STATE_HOME = paths.xdgStateHome
  }

  const userDirs = probeUserToolPaths()
  const pathParts = toolchainReady
    ? [paths.binDir, ...userDirs, process.env.PATH ?? ""]
    : [...userDirs, process.env.PATH ?? ""]
  const seen = new Set()
  process.env.PATH = pathParts
    .flatMap((p) => p.split(path.delimiter))
    .filter((p) => { if (!p || seen.has(p)) return false; seen.add(p); return true })
    .join(path.delimiter)

  try {
    fs.mkdirSync(INTERNAL_DIR, { recursive: true })
    fs.writeFileSync(PATHS_JSON, JSON.stringify(paths, null, 2))
  } catch {}

  return { paths, needsToolchainDownload: !toolchainReady }
}
