const path = require("node:path")
const os = require("node:os")
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const { ipcRenderer } = require("electron")

const REPO_URL = "https://github.com/zenbu-labs/zenbu.git"
const pluginDir = path.join(os.homedir(), ".zenbu", "plugins", "zenbu")

const quietEl = document.getElementById("quiet")
const verboseEl = document.getElementById("verbose")
const quietLabelEl = document.getElementById("quietLabel")
const errorTextEl = document.getElementById("errorText")
const logEl = document.getElementById("log")
const copyBtn = document.getElementById("copyBtn")
const retryBtn = document.getElementById("retryBtn")
const disclosureBtn = document.getElementById("disclosure")
const disclosureLabel = document.getElementById("disclosureLabel")

/** All log lines (step markers + raw stdout/stderr), in order. */
const logLines = []
/** The most recent step title, used if the process exits with no ZENBU_STEP:error. */
let lastStartedStep = null

function appendLog(line) {
  logLines.push(line)
  if (logLines.length > 400) logLines.shift()
  logEl.textContent = logLines.join("\n")
  if (disclosureBtn.getAttribute("aria-expanded") === "true") {
    logEl.scrollTop = logEl.scrollHeight
  }
}

function setErrorText(msg) {
  errorTextEl.textContent = msg
}

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
  quietLabelEl.textContent = "Completing install…"
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
  const payload = [
    errorTextEl.textContent || "(no error)",
    "",
    "Log:",
    logLines.join("\n") || "(empty)",
  ].join("\n")
  let ok = false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(payload)
      ok = true
    }
  } catch {}
  if (!ok) {
    try {
      const { clipboard } = require("electron")
      clipboard.writeText(payload)
      ok = true
    } catch {}
  }
  if (!ok) {
    try {
      const ta = document.createElement("textarea")
      ta.value = payload
      document.body.appendChild(ta)
      ta.select()
      document.execCommand("copy")
      document.body.removeChild(ta)
      ok = true
    } catch {}
  }
  if (ok) {
    const orig = copyBtn.textContent
    copyBtn.classList.add("copied")
    copyBtn.textContent = "Copied"
    setTimeout(() => {
      copyBtn.classList.remove("copied")
      copyBtn.textContent = orig
    }, 1200)
  }
})

/**
 * Parse a single `##ZENBU_STEP:` protocol line. Returns true if it was a
 * protocol line (and thus handled; caller should not re-append as raw log).
 */
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
    case "done": {
      // Keep it quiet in the log; success is conveyed by the next step's start
      // or by overall completion. (Adding duplicate "✓ X" lines would be noise.)
      return true
    }
    case "error": {
      const [stepId, ...msgParts] = rest.split(":")
      const msg = msgParts.join(":")
      appendLog(`× ${stepId}`)
      if (msg) appendLog(`  ${msg}`)
      setErrorText(msg ? `${stepId} failed: ${msg}` : `${stepId} failed`)
      swapToVerbose()
      return true
    }
    case "offer-install": {
      const [tool, ...cmdParts] = rest.split(":")
      const cmd = cmdParts.join(":")
      appendLog(`  install ${tool}: ${cmd}`)
      return true
    }
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
    // Indent raw lines so they group visually under the last step marker.
    appendLog(line.startsWith(" ") ? line : `  ${line}`)
  }
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { FORCE_COLOR: "0" }),
    })
    let stdoutBuf = ""
    let stderrBuf = ""
    proc.stdout.on("data", (data) => {
      stdoutBuf += data.toString()
      const i = stdoutBuf.lastIndexOf("\n")
      if (i !== -1) {
        handleOutput(stdoutBuf.slice(0, i))
        stdoutBuf = stdoutBuf.slice(i + 1)
      }
    })
    proc.stderr.on("data", (data) => {
      stderrBuf += data.toString()
      const i = stderrBuf.lastIndexOf("\n")
      if (i !== -1) {
        handleOutput(stderrBuf.slice(0, i))
        stderrBuf = stderrBuf.slice(i + 1)
      }
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

async function run() {
  try {
    if (!fs.existsSync(pluginDir)) {
      quietLabelEl.textContent = "Cloning Zenbu…"
      fs.mkdirSync(path.dirname(pluginDir), { recursive: true })
      await runCommand(
        "git",
        ["clone", "--depth", "1", "--progress", REPO_URL, pluginDir],
        os.homedir(),
      )
    }

    const setupScript = path.join(pluginDir, "setup.sh")
    if (!fs.existsSync(setupScript)) {
      throw new Error("setup.sh missing at " + setupScript)
    }
    quietLabelEl.textContent = "Completing install…"
    await runCommand("bash", [setupScript], pluginDir)

    quietLabelEl.textContent = "Install complete"
    setTimeout(() => ipcRenderer.send("relaunch"), 800)
  } catch (err) {
    // If setup.sh already emitted ##ZENBU_STEP:error, errorTextEl is set.
    // Otherwise, synthesize a one-liner from the exit reason + last step.
    if (!errorTextEl.textContent) {
      const baseMsg = err && err.message ? err.message : String(err)
      const where = lastStartedStep ? ` during "${lastStartedStep}"` : ""
      setErrorText(`Install failed${where}: ${baseMsg}`)
    }
    swapToVerbose()
  }
}

retryBtn.addEventListener("click", () => {
  resetVerbose()
  run()
})

run()
