/**
 * Zenbu launcher shim.
 *
 * This file is bundled by tsdown (as a second entry alongside `bin.mjs`) and
 * shipped inside `@zenbujs/cli`'s `dist/` as `launcher.mjs`. `zen build:desktop`
 * copies it into the .app bundle as `<app>/launcher.mjs`, and the bundle's
 * `package.json#main` points at it.
 *
 * Its job — and ONLY its job — is to make `~/.zenbu/apps/<name>/` runnable,
 * then dynamic-`import()` the apps-dir's `@zenbujs/core/dist/setup-gate.mjs`.
 *
 * It must NOT import `@zenbujs/core`. The whole point of the shim is to
 * preserve a single framework module identity — the apps-dir copy that pnpm
 * installs on first launch is the one true `@zenbujs/core`. If we imported
 * `@zenbujs/core` here, we'd have two instances and the runtime singleton,
 * `instanceof` checks, and dynohot HMR would all split-brain.
 *
 * Allowed deps: node built-ins + the `electron` main-process API (provided at
 * runtime by the running Electron, marked `external` in tsdown.config.ts).
 */
import { app } from "electron"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// =============================================================================
//                          stdio + logging safety net
// =============================================================================
// When the .app is launched from Finder (or `open <app>`), the main process
// inherits stdout/stderr connected to pipes whose other end launchd
// promptly closes; subsequent writes throw EPIPE. Vite warmup / Effect's
// failure reporter / dynohot / user `console.log`s then crash the whole app
// with "Uncaught Exception: write EPIPE".
//
// Patching `console.log/error` is NOT enough — Effect (and others) capture
// `console.error` at module init time before our wrapper installs, then
// call the captured reference forever. The reliable fix is to patch the
// underlying *streams* (`process.stdout.write`, `process.stderr.write`) so
// even the captured-original `console.error` flows through our try/catch.
const _logDir = path.join(os.homedir(), ".zenbu", ".internal")
fs.mkdirSync(_logDir, { recursive: true })
const _logStream = fs.createWriteStream(path.join(_logDir, "launcher.log"), { flags: "a" })
_logStream.write(`\n=== launcher ${new Date().toISOString()} pid=${process.pid} ===\n`)

function silenceStream(stream: NodeJS.WriteStream | undefined, prefix: string): void {
  if (!stream) return
  const original = stream.write.bind(stream)
  const safeWrite = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      _logStream.write(prefix + text)
    } catch {}
    try {
      return original(chunk as never, encodingOrCb as never, cb as never)
    } catch {
      return true
    }
  }) as NodeJS.WriteStream["write"]
  ;(stream as unknown as { write: NodeJS.WriteStream["write"] }).write = safeWrite
  stream.on("error", () => {})
}

silenceStream(process.stdout, "")
silenceStream(process.stderr, "[ERR] ")

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  try { _logStream.write("[UNCAUGHT] " + (err.stack ?? err.message ?? String(err)) + "\n") } catch {}
  if (err.code === "EPIPE") return
})
process.on("unhandledRejection", (reason: unknown) => {
  try {
    const err = reason as NodeJS.ErrnoException | undefined
    _logStream.write("[UNHANDLED] " + (err?.stack ?? err?.message ?? String(reason)) + "\n")
  } catch {}
})

interface AppConfig {
  name: string
  mirrorUrl?: string
  branch?: string
  version?: string
  host?: string
}

const APP_PATH = app.getAppPath()
const RESOURCES_PATH = path.dirname(APP_PATH)

function readAppConfig(): AppConfig {
  const configPath = path.join(APP_PATH, "app-config.json")
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig
}

function appsDirFor(name: string): string {
  if (process.env.ZENBU_APPS_DIR) return path.resolve(process.env.ZENBU_APPS_DIR)
  return path.join(os.homedir(), ".zenbu", "apps", name)
}

async function copySeed(seedDir: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.cp(seedDir, dest, { recursive: true })
}

async function fileHash(hash: crypto.Hash, filePath: string): Promise<void> {
  hash.update(filePath)
  hash.update("\0")
  try {
    hash.update(await fsp.readFile(filePath))
  } catch {}
  hash.update("\0")
}

async function depsSignature(appsDir: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  await fileHash(hash, path.join(appsDir, "package.json"))
  await fileHash(hash, path.join(appsDir, "pnpm-lock.yaml"))
  hash.update(process.versions.electron ?? "no-electron")
  hash.update("\0")
  hash.update(process.platform)
  hash.update("\0")
  hash.update(process.arch)
  return hash.digest("hex")
}

function bundledToolPath(name: string): string | null {
  const candidates = [
    path.join(RESOURCES_PATH, "toolchain", "bin", name),
    path.join(RESOURCES_PATH, "toolchain", name),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function electronTargetVersion(appsDir: string): string {
  if (process.versions.electron) return process.versions.electron
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appsDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const version =
      pkg.devDependencies?.electron ??
      pkg.dependencies?.electron ??
      // trash slop
      ""
    return version.replace(/^[^\d]*/, "") || "42.0.0"
  } catch {
    return "42.0.0"
  }
}

async function runPnpmInstall(appsDir: string): Promise<void> {
  const pnpm = bundledToolPath("pnpm")
  if (!pnpm) {
    throw new Error(
      `bundled pnpm not found in ${RESOURCES_PATH}/toolchain. The .app is missing required toolchain binaries.`,
    )
  }
  const target = electronTargetVersion(appsDir)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpm, ["install", "--no-frozen-lockfile"], {
      cwd: appsDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        HOME: path.join(appsDir, ".zenbu", ".node-gyp"),
        npm_config_runtime: "electron",
        npm_config_target: target,
        npm_config_disturl: "https://electronjs.org/headers",
        npm_config_arch: process.arch,
      },
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm install exited with code ${code}`))
    })
  })
}

async function ensureAppsDir(seedDir: string, appsDir: string): Promise<void> {
  if (existsSync(appsDir)) return
  if (!existsSync(seedDir)) {
    throw new Error(
      `apps dir ${appsDir} is missing and no seed/ directory found in the .app at ${seedDir}.`,
    )
  }
  console.log(`[launcher] seeding ${appsDir} from bundled seed`)
  await copySeed(seedDir, appsDir)
}

async function ensureDepsInstalled(appsDir: string): Promise<void> {
  const sigPath = path.join(appsDir, ".zenbu", "deps-sig")
  const nodeModules = path.join(appsDir, "node_modules")
  const nextSig = await depsSignature(appsDir)

  if (existsSync(nodeModules)) {
    try {
      const current = await fsp.readFile(sigPath, "utf8")
      if (current === nextSig) return
    } catch {}
  }

  console.log(`[launcher] installing deps in ${appsDir}`)
  await runPnpmInstall(appsDir)
  await fsp.mkdir(path.dirname(sigPath), { recursive: true })
  await fsp.writeFile(sigPath, nextSig)
}

async function handoff(appsDir: string): Promise<void> {
  const entry = path.join(
    appsDir,
    "node_modules",
    "@zenbujs",
    "core",
    "dist",
    "setup-gate.mjs",
  )
  if (!existsSync(entry)) {
    throw new Error(
      `[launcher] expected entry not found: ${entry}. The seeded app may be missing @zenbujs/core in its dependencies.`,
    )
  }

  if (!process.argv.some((arg) => arg.startsWith("--project="))) {
    process.argv.push(`--project=${appsDir}`)
  }
  process.env.ZENBU_LAUNCHED_FROM_BUNDLE = "1"
  await import(entry)
}

async function main(): Promise<void> {
  await app.whenReady()

  const cfg = readAppConfig()
  const appsDir = appsDirFor(cfg.name)
  const seedDir = path.join(APP_PATH, "seed")

  await ensureAppsDir(seedDir, appsDir)
  await ensureDepsInstalled(appsDir)
  await handoff(appsDir)
}

main().catch((err) => {
  console.error("[launcher] fatal:", err)
  app.exit(1)
})
