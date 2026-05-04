import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { findInstalledVersion, getElectronBinary } from "./runtime"

export async function runOpenStandalone(argv: string[]) {
  let blocking = false
  let runtimeVersion: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--blocking") blocking = true
    else if (arg === "--runtime" || arg === "-r") runtimeVersion = argv[++i] ?? null
    else if (arg.startsWith("--runtime=")) runtimeVersion = arg.slice("--runtime=".length)
  }

  const cwd = process.cwd()
  if (!fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) {
    console.error("zen open: no zenbu.plugin.json found in current directory")
    process.exit(1)
  }

  if (!runtimeVersion) runtimeVersion = findInstalledVersion()
  if (!runtimeVersion) {
    console.error("zen open: no Electron runtime installed. Run: zen runtime install")
    process.exit(1)
  }
  if (!runtimeVersion.includes(".")) runtimeVersion += ".0.0"

  const electronBin = getElectronBinary(runtimeVersion)
  if (!fs.existsSync(electronBin)) {
    console.error(`zen open: Electron ${runtimeVersion} not installed. Run: zen runtime install ${runtimeVersion}`)
    process.exit(1)
  }

  const bootMjs = path.join(cwd, "zenbu", "packages", "runtime", "boot.mjs")
  if (!fs.existsSync(bootMjs)) {
    console.error(`zen open: boot.mjs not found at ${bootMjs}`)
    console.error("Make sure the zenbu submodule is set up with packages/runtime/")
    process.exit(1)
  }

  const args = [bootMjs, `--project=${cwd}`]

  if (blocking) {
    const child = spawn(electronBin, args, { stdio: "inherit" })
    process.on("SIGINT", () => child.kill("SIGINT"))
    process.on("SIGTERM", () => child.kill("SIGTERM"))
    child.on("exit", (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0))
    })
  } else {
    const child = spawn(electronBin, args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }
}
