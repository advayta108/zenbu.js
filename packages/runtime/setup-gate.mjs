import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const _logDir = path.join(os.homedir(), ".zenbu", ".internal")
fs.mkdirSync(_logDir, { recursive: true })
const _logStream = fs.createWriteStream(path.join(_logDir, "setup-gate.log"), { flags: "a" })
_logStream.write(`\n=== setup-gate ${new Date().toISOString()} pid=${process.pid} ===\n`)
const _origLog = console.log.bind(console)
const _origErr = console.error.bind(console)
console.log = (...args) => { try { _logStream.write(args.join(" ") + "\n") } catch {} try { _origLog(...args) } catch {} }
console.error = (...args) => { try { _logStream.write("[ERR] " + args.join(" ") + "\n") } catch {} try { _origErr(...args) } catch {} }
process.on("uncaughtException", (err) => {
  _logStream.write("[UNCAUGHT] " + (err.stack || err.message || err) + "\n")
  if (err.code === "EPIPE") return
})
process.stdout?.on?.("error", () => {})
process.stderr?.on?.("error", () => {})
import { app, BrowserWindow, ipcMain } from "electron"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFileCb)

const APP_PATH = app.getAppPath()
const CONFIG = JSON.parse(fs.readFileSync(path.join(APP_PATH, "app-config.json"), "utf8"))
const APP_NAME = CONFIG.name
const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "Zenbu")
const BIN_DIR = path.join(CACHE_ROOT, "bin")
const RUNTIMES_DIR = path.join(CACHE_ROOT, "runtimes")
const APPS_DIR = path.join(os.homedir(), ".zenbu", "apps")
const PROJECT_DIR = path.join(APPS_DIR, APP_NAME)
const SETUP_VERSION_FILE = path.join(PROJECT_DIR, ".setup-version")

function isSetupDone() {
  if (!fs.existsSync(PROJECT_DIR)) return false
  if (!fs.existsSync(SETUP_VERSION_FILE)) return false
  try {
    const current = fs.readFileSync(SETUP_VERSION_FILE, "utf8").trim()
    return current === String(CONFIG.setupVersion)
  } catch { return false }
}

async function seedRuntime() {
  const toolchainDir = path.join(APP_PATH, "toolchain")

  await fsp.mkdir(BIN_DIR, { recursive: true })

  const bunSrc = path.join(toolchainDir, "bun")
  const bunDest = path.join(BIN_DIR, "bun")
  if (fs.existsSync(bunSrc) && !fs.existsSync(bunDest)) {
    await fsp.copyFile(bunSrc, bunDest)
    await fsp.chmod(bunDest, 0o755)
    try { await fsp.unlink(path.join(BIN_DIR, "node")) } catch {}
    await fsp.symlink("bun", path.join(BIN_DIR, "node"))
  }

  const pnpmSrc = path.join(toolchainDir, "pnpm")
  const pnpmDest = path.join(BIN_DIR, "pnpm")
  if (fs.existsSync(pnpmSrc) && !fs.existsSync(pnpmDest)) {
    await fsp.copyFile(pnpmSrc, pnpmDest)
    await fsp.chmod(pnpmDest, 0o755)
  }

  if (CONFIG.electronVersion) {
    const runtimeDir = path.join(RUNTIMES_DIR, CONFIG.electronVersion)
    const electronDest = path.join(runtimeDir, "Electron.app")
    if (!fs.existsSync(electronDest)) {
      await fsp.mkdir(runtimeDir, { recursive: true })
      const electronAppSrc = path.resolve(APP_PATH, "..", "..")
      try {
        await execFileAsync("cp", ["-c", "-R", electronAppSrc, electronDest])
      } catch {}
    }
  }
}

function runSetup() {
  const win = new BrowserWindow({
    width: 440,
    height: 320,
    resizable: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#F4F4F4",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  win.loadFile(path.join(APP_PATH, "setup", "index.html"))
}

function boot() {
  const bootMjs = path.join(PROJECT_DIR, "zenbu", "packages", "runtime", "boot.mjs")
  if (!fs.existsSync(bootMjs)) {
    console.error(`[setup-gate] boot.mjs not found at ${bootMjs}`)
    app.exit(1)
    return
  }
  process.argv.push(`--project=${PROJECT_DIR}`)
  import(bootMjs)
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

ipcMain.on("relaunch", () => {
  app.relaunch()
  app.exit()
})

async function cleanupOldRuntimes() {
  if (!CONFIG.electronVersion || !fs.existsSync(RUNTIMES_DIR)) return
  const currentMajor = parseInt(CONFIG.electronVersion.split(".")[0], 10)
  try {
    const entries = await fsp.readdir(RUNTIMES_DIR)
    for (const entry of entries) {
      const major = parseInt(entry.split(".")[0], 10)
      if (!isNaN(major) && major < currentMajor) {
        await fsp.rm(path.join(RUNTIMES_DIR, entry), { recursive: true, force: true })
        console.log(`[setup-gate] cleaned up old runtime: ${entry}`)
      }
    }
  } catch {}
}

app.whenReady().then(async () => {
  await seedRuntime()
  await cleanupOldRuntimes()

  if (!fs.existsSync(PROJECT_DIR)) {
    runSetup()
    return
  }

  if (!isSetupDone()) {
    runSetup()
    return
  }

  boot()
})
