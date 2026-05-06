const path = require("node:path")
const os = require("node:os")
const fs = require("node:fs")
const { spawn, execFile } = require("node:child_process")
const { app, ipcRenderer } = require("electron")

const APP_PATH = app?.getAppPath?.() ?? path.resolve(__dirname, "..")
const CONFIG = JSON.parse(fs.readFileSync(path.join(APP_PATH, "app-config.json"), "utf8"))
const APP_NAME = CONFIG.name
const REPO_URL = CONFIG.repoUrl
const BRANCH = CONFIG.branch || "main"
const SETUP_VERSION = String(CONFIG.setupVersion || 1)

const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "Zenbu")
const BIN_DIR = path.join(CACHE_ROOT, "bin")
const BUN_BIN = path.join(BIN_DIR, "bun")
const APPS_DIR = path.join(os.homedir(), ".zenbu", "apps")
const PROJECT_DIR = path.join(APPS_DIR, APP_NAME)
const SETUP_VERSION_FILE = path.join(PROJECT_DIR, ".setup-version")

let dugitGit
try {
  dugitGit = require("dugite").GitProcess
} catch {
  dugitGit = null
}

const quietEl = document.getElementById("quiet")
const verboseEl = document.getElementById("verbose")
const quietLabelEl = document.getElementById("quietLabel")
const errorTextEl = document.getElementById("errorText")
const logEl = document.getElementById("log")
const copyBtn = document.getElementById("copyBtn")
const retryBtn = document.getElementById("retryBtn")
const disclosureBtn = document.getElementById("disclosure")
const disclosureLabel = document.getElementById("disclosureLabel")

const logLines = []
let lastStartedStep = null

function appendLog(line) {
  logLines.push(line)
  if (logLines.length > 400) logLines.shift()
  logEl.textContent = logLines.join("\n")
  if (disclosureBtn.getAttribute("aria-expanded") === "true") {
    logEl.scrollTop = logEl.scrollHeight
  }
}

function setErrorText(msg) { errorTextEl.textContent = msg }

function swapToVerbose() {
  quietEl.style.display = "none"
  verboseEl.style.display = "flex"
}

function resetVerbose() {
  logLines.length = 0
  logEl.textContent = ""
  errorTextEl.textContent = ""
  verboseEl.style.display = "none"
  quietEl.style.display = "flex"
  quietLabelEl.textContent = "Setting up…"
  disclosureBtn.setAttribute("aria-expanded", "false")
  disclosureLabel.textContent = "Show log"
  logEl.style.display = "none"
  lastStartedStep = null
}

disclosureBtn.addEventListener("click", () => {
  const open = disclosureBtn.getAttribute("aria-expanded") === "true"
  const next = !open
  disclosureBtn.setAttribute("aria-expanded", String(next))
  logEl.style.display = next ? "block" : "none"
  disclosureLabel.textContent = next ? "Hide log" : "Show log"
  if (next) logEl.scrollTop = logEl.scrollHeight
})

copyBtn.addEventListener("click", async () => {
  const payload = [errorTextEl.textContent || "(no error)", "", "Log:", logLines.join("\n") || "(empty)"].join("\n")
  try { await navigator.clipboard.writeText(payload) } catch {
    try { require("electron").clipboard.writeText(payload) } catch {}
  }
  const orig = copyBtn.textContent
  copyBtn.classList.add("copied")
  copyBtn.textContent = "Copied"
  setTimeout(() => { copyBtn.classList.remove("copied"); copyBtn.textContent = orig }, 1200)
})

function handleProtocolLine(line) {
  const m = /^##ZENBU_STEP:([a-z-]+):(.+)$/.exec(line)
  if (!m) return false
  const event = m[1]
  const rest = m[2]
  switch (event) {
    case "start": {
      const [stepId, ...titleParts] = rest.split(":")
      const title = titleParts.join(":") || stepId
      lastStartedStep = title
      appendLog(`→ ${title}`)
      return true
    }
    case "done": return true
    case "error": {
      const [stepId, ...msgParts] = rest.split(":")
      const msg = msgParts.join(":")
      appendLog(`× ${stepId}`)
      if (msg) appendLog(`  ${msg}`)
      setErrorText(msg ? `${stepId} failed: ${msg}` : `${stepId} failed`)
      swapToVerbose()
      return true
    }
    case "offer-install":
    case "download":
    case "all-done":
      return true
    default:
      return false
  }
}

function handleOutput(buffer) {
  for (const rawLine of buffer.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (handleProtocolLine(line)) continue
    appendLog(line.startsWith(" ") ? line : `  ${line}`)
  }
}

function runCommand(cmd, args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { FORCE_COLOR: "0" }, extraEnv || {}),
    })
    let stdoutBuf = ""
    let stderrBuf = ""
    proc.stdout.on("data", (data) => {
      stdoutBuf += data.toString()
      const i = stdoutBuf.lastIndexOf("\n")
      if (i !== -1) { handleOutput(stdoutBuf.slice(0, i)); stdoutBuf = stdoutBuf.slice(i + 1) }
    })
    proc.stderr.on("data", (data) => {
      stderrBuf += data.toString()
      const i = stderrBuf.lastIndexOf("\n")
      if (i !== -1) { handleOutput(stderrBuf.slice(0, i)); stderrBuf = stderrBuf.slice(i + 1) }
    })
    proc.on("close", (code) => {
      if (stdoutBuf) handleOutput(stdoutBuf)
      if (stderrBuf) handleOutput(stderrBuf)
      if (code === 0) resolve()
      else reject(new Error(cmd + " exited with code " + code))
    })
    proc.on("error", reject)
  })
}

function resolveGitBin() {
  const bundledGit = path.join(APP_PATH, "toolchain", "git", "bin", "git")
  if (fs.existsSync(bundledGit)) {
    const gitDir = path.join(APP_PATH, "toolchain", "git")
    process.env.GIT_EXEC_PATH = path.join(gitDir, "libexec", "git-core")
    process.env.GIT_TEMPLATE_DIR = path.join(gitDir, "share", "git-core", "templates")
    return bundledGit
  }
  return "git"
}

async function run() {
  try {
    const gitBin = resolveGitBin()
    appendLog(`  using git: ${gitBin}`)

    if (!fs.existsSync(PROJECT_DIR)) {
      quietLabelEl.textContent = `Downloading ${APP_NAME}…`
      fs.mkdirSync(APPS_DIR, { recursive: true })
      await runCommand(gitBin, [
        "clone", "--depth", "1", "--recursive", "--branch", BRANCH,
        "--progress", REPO_URL, PROJECT_DIR,
      ], APPS_DIR)
      appendLog("  ✓ cloned")
    } else {
      appendLog("  ✓ already downloaded")
    }

    const setupTs = path.join(PROJECT_DIR, "zenbu", "packages", "init", "setup.ts")
    if (fs.existsSync(setupTs)) {
      quietLabelEl.textContent = "Completing setup…"
      await runCommand(BUN_BIN, [setupTs], path.join(PROJECT_DIR, "zenbu"), {
        ZENBU_CONFIG_PATH: path.join(PROJECT_DIR, "config.json"),
      })
    }

    if (fs.existsSync(path.join(PROJECT_DIR, "package.json"))) {
      quietLabelEl.textContent = "Installing app dependencies…"
      const pnpmBin = path.join(BIN_DIR, "pnpm")
      const npmBin = fs.existsSync(pnpmBin) ? pnpmBin : "npm"
      await runCommand(npmBin, ["install"], PROJECT_DIR)
    }

    fs.writeFileSync(SETUP_VERSION_FILE, SETUP_VERSION)

    quietLabelEl.textContent = "Setup complete"
    setTimeout(() => {
      ipcRenderer.send("relaunch")
    }, 800)
  } catch (err) {
    if (!errorTextEl.textContent) {
      const baseMsg = err && err.message ? err.message : String(err)
      const where = lastStartedStep ? ` during "${lastStartedStep}"` : ""
      setErrorText(`Setup failed${where}: ${baseMsg}`)
    }
    swapToVerbose()
  }
}

retryBtn.addEventListener("click", () => { resetVerbose(); run() })
run()
