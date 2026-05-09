/**
 * Zenbu launcher shim.
 *
 * Shipped inside `@zenbujs/core/dist/launcher.mjs` and copied into the .app
 * bundle by `zen build:electron`. The bundle's `package.json#main` points
 * here, so this is the FIRST user code Electron evaluates after main process
 * boot.
 *
 * Job:
 *   1. Clone or fetch the configured source mirror into `~/.zenbu/apps/<name>/`
 *      (we no longer bundle a `seed/` snapshot — every launch picks up
 *      whatever's on the mirror's branch HEAD).
 *   2. Run `pnpm install` against the apps-dir using the bundled toolchain.
 *   3. Dynamic-`import()` the apps-dir's `@zenbujs/core/dist/setup-gate.mjs`,
 *      which becomes the one-and-only `@zenbujs/core` instance for the rest
 *      of the process lifetime.
 *
 * It must NOT import `@zenbujs/core`. Doing so would create two distinct
 * module identities (this bundled copy + the apps-dir copy) and split-brain
 * the runtime singleton, dynohot HMR, and `instanceof` checks.
 *
 * Allowed deps: node built-ins, the `electron` main-process API (provided
 * at runtime), and `isomorphic-git` (bundled into this file by tsdown — see
 * `packages/core/tsdown.config.ts` `neverBundle: ["electron"]`).
 */
import { app } from "electron"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as git from "isomorphic-git"
import http from "isomorphic-git/http/node"

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

interface MirrorRef {
  url: string
  branch: string
}

function resolveMirror(cfg: AppConfig): MirrorRef {
  if (!cfg.mirrorUrl) {
    throw new Error(
      "[launcher] no mirror configured. The .app's app-config.json must " +
        "contain `mirrorUrl` (the GitHub repo cloned on first launch). " +
        "Configure `mirror.target` in zenbu.build.ts and rebuild.",
    )
  }
  return { url: cfg.mirrorUrl, branch: cfg.branch ?? "main" }
}

/**
 * Look like a real git working tree? (Distinguish "we cloned this" from a
 * partial copy left behind by an interrupted clone.)
 */
function isExistingClone(dir: string): boolean {
  return existsSync(path.join(dir, ".git", "HEAD"))
}

/**
 * True if the working tree has uncommitted modifications. We use this as a
 * "respect the user's edits" guard before fast-forwarding from origin.
 */
async function hasLocalModifications(dir: string): Promise<boolean> {
  try {
    const matrix = await git.statusMatrix({ fs, dir })
    // [filepath, head, workdir, stage] — when all three are 1, the file is
    // tracked AND clean. Anything else means modified/added/deleted.
    return matrix.some(
      ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1,
    )
  } catch {
    return false
  }
}

async function cloneMirror(dir: string, mirror: MirrorRef): Promise<void> {
  console.log(`[launcher] cloning ${mirror.url}#${mirror.branch} -> ${dir}`)
  await fsp.mkdir(dir, { recursive: true })
  await git.clone({
    fs,
    http,
    dir,
    url: mirror.url,
    ref: mirror.branch,
    singleBranch: true,
    depth: 1,
  })
  console.log(`[launcher] clone complete`)
}

/**
 * Fast-forward `dir` to the remote tip when:
 *   1. We have a working tree (otherwise we'd be cloning, not pulling).
 *   2. The local HEAD differs from origin/<branch>.
 *   3. The working tree is clean — never silently overwrite user edits.
 *
 * On clean trees with new commits, we `checkout --force` the remote sha.
 * That's equivalent to `git reset --hard origin/<branch>` for a fast-forward
 * scenario and avoids isomorphic-git's lack of a built-in pull operation.
 */
async function fetchAndUpdate(dir: string, mirror: MirrorRef): Promise<void> {
  try {
    await git.fetch({
      fs,
      http,
      dir,
      url: mirror.url,
      ref: mirror.branch,
      singleBranch: true,
      depth: 1,
      tags: false,
    })
  } catch (err) {
    console.warn(`[launcher] fetch failed (${(err as Error).message}); using local state`)
    return
  }

  let localSha: string
  let remoteSha: string
  try {
    localSha = await git.resolveRef({ fs, dir, ref: "HEAD" })
    remoteSha = await git.resolveRef({
      fs,
      dir,
      ref: `refs/remotes/origin/${mirror.branch}`,
    })
  } catch (err) {
    console.warn(`[launcher] could not resolve refs (${(err as Error).message}); using local state`)
    return
  }
  if (localSha === remoteSha) {
    console.log(`[launcher] up to date (${localSha.slice(0, 7)})`)
    return
  }

  if (await hasLocalModifications(dir)) {
    console.warn(
      `[launcher] working tree at ${dir} has uncommitted modifications; ` +
        `skipping fast-forward to ${remoteSha.slice(0, 7)}.`,
    )
    return
  }

  console.log(
    `[launcher] fast-forwarding ${localSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)}`,
  )
  await git.checkout({ fs, dir, ref: remoteSha, force: true })
}

async function ensureAppsDir(appsDir: string, mirror: MirrorRef): Promise<void> {
  if (isExistingClone(appsDir)) {
    await fetchAndUpdate(appsDir, mirror)
    return
  }
  if (existsSync(appsDir)) {
    const entries = await fsp.readdir(appsDir).catch(() => [] as string[])
    if (entries.length > 0) {
      throw new Error(
        `[launcher] ${appsDir} exists and isn't a git working tree (has ${entries.length} entries). ` +
          `Move or delete it, then relaunch.`,
      )
    }
  }
  await cloneMirror(appsDir, mirror)
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
      `[launcher] expected entry not found: ${entry}. The cloned source may be missing @zenbujs/core in its dependencies.`,
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
  const mirror = resolveMirror(cfg)
  const appsDir = appsDirFor(cfg.name)

  await ensureAppsDir(appsDir, mirror)
  await ensureDepsInstalled(appsDir)
  await handoff(appsDir)
}

main().catch((err) => {
  console.error("[launcher] fatal:", err)
  app.exit(1)
})
