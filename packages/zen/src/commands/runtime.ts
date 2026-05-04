import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { createWriteStream, mkdirSync } from "node:fs"

const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "Zenbu")
const RUNTIMES_DIR = path.join(CACHE_ROOT, "runtimes")

function getRuntimeDir(version: string): string {
  return path.join(RUNTIMES_DIR, version)
}

function getElectronBinary(version: string): string {
  return path.join(getRuntimeDir(version), "Electron.app", "Contents", "MacOS", "Electron")
}

function getDownloadUrl(version: string): string {
  const arch = os.arch() === "arm64" ? "arm64" : "x64"
  return `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-darwin-${arch}.zip`
}

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function installRuntime(version: string): Promise<void> {
  mkdirSync(RUNTIMES_DIR, { recursive: true })

  const runtimeDir = getRuntimeDir(version)
  if (fs.existsSync(getElectronBinary(version))) {
    console.log(`  ✓ Electron ${version} already installed`)
    return
  }

  const url = getDownloadUrl(version)
  const zipPath = path.join(os.tmpdir(), `electron-v${version}.zip`)

  console.log(`  → downloading Electron ${version}...`)
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error("No response body")

  const total = Number(response.headers.get("content-length") ?? 0)
  let received = 0

  const transform = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (total > 0) {
        const pct = Math.round((received / total) * 100)
        process.stdout.write(`\r  → downloading... ${pct}%`)
      }
      controller.enqueue(chunk)
    },
  })

  const readable = Readable.fromWeb(response.body.pipeThrough(transform) as any)
  const writable = createWriteStream(zipPath)
  await pipeline(readable, writable)
  console.log("")

  console.log("  → extracting...")
  const extractDir = path.join(os.tmpdir(), `zenbu-electron-extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })
  await exec("ditto", ["-xk", zipPath, extractDir])

  if (fs.existsSync(runtimeDir)) {
    await exec("rm", ["-rf", runtimeDir])
  }
  mkdirSync(runtimeDir, { recursive: true })

  await exec("ditto", [
    path.join(extractDir, "Electron.app"),
    path.join(runtimeDir, "Electron.app"),
  ])

  const manifest = {
    version,
    platform: "darwin",
    arch: os.arch(),
    installedAt: Date.now(),
  }
  fs.writeFileSync(
    path.join(runtimeDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  )

  await exec("rm", ["-rf", extractDir])
  try { fs.unlinkSync(zipPath) } catch {}

  console.log(`  ✓ Electron ${version} installed`)
}

function listRuntimes(): void {
  if (!fs.existsSync(RUNTIMES_DIR)) {
    console.log("  No runtimes installed.")
    return
  }
  const entries = fs.readdirSync(RUNTIMES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))

  if (entries.length === 0) {
    console.log("  No runtimes installed.")
    return
  }

  for (const entry of entries) {
    const binary = path.join(RUNTIMES_DIR, entry.name, "Electron.app", "Contents", "MacOS", "Electron")
    const status = fs.existsSync(binary) ? "✓" : "✗"
    console.log(`  ${status} ${entry.name}`)
  }
}

async function removeRuntime(version: string): Promise<void> {
  const runtimeDir = getRuntimeDir(version)
  if (!fs.existsSync(runtimeDir)) {
    console.error(`  Runtime ${version} not found.`)
    process.exit(1)
  }
  await exec("rm", ["-rf", runtimeDir])
  console.log(`  ✓ Removed Electron ${version}`)
}

function findInstalledVersion(): string | null {
  if (!fs.existsSync(RUNTIMES_DIR)) return null
  const entries = fs.readdirSync(RUNTIMES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(getElectronBinary(e.name)))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
  return entries[0]?.name ?? null
}

export { getRuntimeDir, getElectronBinary, findInstalledVersion, RUNTIMES_DIR }

export async function runRuntime(argv: string[]) {
  const sub = argv[0]

  if (!sub || sub === "list") {
    console.log("\nInstalled Electron runtimes:\n")
    listRuntimes()
    console.log("")
    return
  }

  if (sub === "install") {
    const version = argv[1] ?? "35.0.0"
    const fullVersion = version.includes(".") ? version : `${version}.0.0`
    console.log(`\nInstalling Electron runtime ${fullVersion}...\n`)
    await installRuntime(fullVersion)
    console.log("")
    return
  }

  if (sub === "remove") {
    const version = argv[1]
    if (!version) {
      console.error("Usage: zen runtime remove <version>")
      process.exit(1)
    }
    const fullVersion = version.includes(".") ? version : `${version}.0.0`
    await removeRuntime(fullVersion)
    return
  }

  console.error(`Unknown runtime subcommand: ${sub}`)
  console.error("Usage: zen runtime [install|list|remove] [version]")
  process.exit(1)
}
