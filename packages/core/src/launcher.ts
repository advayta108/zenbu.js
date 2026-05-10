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
import { app, BaseWindow, WebContentsView } from "electron"
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

type PackageManagerSpec =
  | { type: "pnpm"; version: string }
  | { type: "npm"; version: string }
  | { type: "yarn"; version: string }
  | { type: "bun"; version: string }

interface AppConfig {
  name: string
  mirrorUrl?: string
  branch?: string
  version?: string
  host?: string
  /**
   * Which PM to use for first-launch install. Older bundles built before
   * this field existed get an implicit pnpm@10.33.0 (matches the previous
   * hardcoded behavior).
   */
  packageManager?: PackageManagerSpec
  /**
   * Path (relative to the .app's `Resources/`) of the staged
   * `installing.html`, when the user shipped one. When set, the launcher
   * pops a window with this HTML before clone + first install and emits
   * IPC progress events to it. Older bundles without this field get the
   * old "no window during install" behavior (just a dock bounce).
   */
  installingHtml?: string
  /**
   * Path (relative to `Resources/`) of the framework's built-in preload
   * that exposes `window.zenbuInstall`. Always set when `installingHtml`
   * is set.
   */
  installingPreload?: string
}

const LEGACY_PACKAGE_MANAGER: PackageManagerSpec = {
  type: "pnpm",
  version: "10.33.0",
}

function lockfileFor(type: PackageManagerSpec["type"]): string {
  switch (type) {
    case "pnpm":
      return "pnpm-lock.yaml"
    case "npm":
      return "package-lock.json"
    case "yarn":
      return "yarn.lock"
    case "bun":
      return "bun.lock"
  }
}

function isYarnBerry(version: string): boolean {
  const major = parseInt(version.split(".")[0] ?? "", 10)
  return Number.isFinite(major) && major >= 2
}

const APP_PATH = app.getAppPath()
const RESOURCES_PATH = path.dirname(APP_PATH)

// =============================================================================
//                          installing.html window
// =============================================================================
// When the user ships an `installing.html` (declared by presence of
// `<uiEntrypoint>/installing.html` and staged into Resources/ by
// `zen build:electron`), the launcher pops a BaseWindow + WebContentsView
// loading that HTML BEFORE clone + first install. The framework's built-in
// preload (`installing-preload.cjs`) exposes `window.zenbuInstall.on(event, cb)`;
// the launcher emits events on these channels:
//
//   zenbu:install:step      { id, label }
//   zenbu:install:message   { text }
//   zenbu:install:progress  { phase?, loaded?, total?, ratio? }
//   zenbu:install:done      { id }
//   zenbu:install:error     { id?, message }
//
// On successful install, the launcher hands the BaseWindow off to setup-gate
// via `globalThis.__zenbu_boot_windows__`; setup-gate's `spawnSplashWindow`
// adopts it and swaps the WebContentsView in place for splash content.

type InstallStepId = "clone" | "fetch" | "install" | "handoff"
type InstallEvent = "step" | "message" | "progress" | "done" | "error"

interface ProgressPayload {
  phase?: string
  loaded?: number
  total?: number
  ratio?: number
}

interface Installer {
  emit(event: InstallEvent, payload: unknown): void
  step(id: InstallStepId, label: string): void
  done(id: InstallStepId): void
  message(text: string): void
  progress(payload: ProgressPayload): void
  fail(err: unknown, id?: InstallStepId): void
  /** Currently-active step id, or null before any step has been emitted. */
  readonly currentStep: InstallStepId | null
  /**
   * Hand the BaseWindow off to setup-gate via globalThis.__zenbu_boot_windows__,
   * so setup-gate's spawnSplashWindow can adopt it and swap content in
   * place (no second window flash).
   */
  handoff(): void
}

function readBgColor(htmlPath: string, fallback: string): string {
  try {
    const html = fs.readFileSync(htmlPath, "utf8")
    const match = html.match(
      /<meta\s+name=["']zenbu-bg["']\s+content=["']([^"']+)["']/i,
    )
    if (match?.[1]) return match[1]
  } catch {}
  return fallback
}

async function maybeOpenInstallingWindow(cfg: AppConfig): Promise<Installer | null> {
  if (!cfg.installingHtml) return null
  const htmlPath = path.join(RESOURCES_PATH, cfg.installingHtml)
  if (!existsSync(htmlPath)) {
    _logStream.write(`[installer] installing.html not found at ${htmlPath}; skipping window\n`)
    return null
  }
  const preloadPath = cfg.installingPreload
    ? path.join(RESOURCES_PATH, cfg.installingPreload)
    : null
  if (!preloadPath || !existsSync(preloadPath)) {
    _logStream.write(`[installer] installing-preload.cjs not found at ${preloadPath}; skipping window\n`)
    return null
  }

  const backgroundColor = readBgColor(htmlPath, "#F4F4F4")
  // Match the splash window dimensions / chrome so the handoff is seamless
  // (setup-gate's spawnSplashWindow adopts this BaseWindow as-is).
  const win = new BaseWindow({
    width: 1100,
    height: 750,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor,
  })
  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.contentView.addChildView(view)
  const layout = (): void => {
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  layout()
  win.on("resize", layout)

  // Buffer events emitted before the page has finished loading. `loadFile`
  // resolves on did-finish-load, but the first launcher events (step("clone"))
  // can fire within milliseconds of `maybeOpenInstallingWindow` returning —
  // before the renderer process has attached its preload + page listeners.
  // Without buffering, those early events are silently dropped and the UI
  // stays stuck on its initial state.
  let ready = false
  type Pending = { event: InstallEvent; payload: unknown }
  const pending: Pending[] = []
  view.webContents.once("did-finish-load", () => {
    ready = true
    for (const p of pending) {
      try {
        if (view.webContents.isDestroyed()) break
        view.webContents.send(`zenbu:install:${p.event}`, p.payload)
      } catch {}
    }
    pending.length = 0
  })
  view.webContents.once("did-fail-load", (_e, _code, desc) => {
    _logStream.write(`[installer] did-fail-load: ${desc}\n`)
    // Drain anyway so we don't leak the buffer; the events are lost but
    // the launcher continues to make progress.
    pending.length = 0
    ready = true
  })

  void view.webContents.loadFile(htmlPath).catch((err) => {
    _logStream.write(`[installer] loadFile failed: ${(err as Error).message ?? err}\n`)
  })

  const emit = (event: InstallEvent, payload: unknown): void => {
    if (!ready) {
      pending.push({ event, payload })
      return
    }
    try {
      if (view.webContents.isDestroyed()) return
      view.webContents.send(`zenbu:install:${event}`, payload)
    } catch {}
  }

  let currentStep: InstallStepId | null = null
  const installer: Installer = {
    emit,
    get currentStep() { return currentStep },
    step(id, label) {
      currentStep = id
      emit("step", { id, label })
    },
    done(id) { emit("done", { id }) },
    message(text) { emit("message", { text }) },
    progress(payload) { emit("progress", payload) },
    fail(err, id) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      emit("error", { id: id ?? currentStep ?? undefined, message })
    },
    handoff() {
      const slot = globalThis as unknown as {
        __zenbu_boot_windows__?: Array<{ windowId: string; win: BaseWindow }>
      }
      slot.__zenbu_boot_windows__ = [
        ...(slot.__zenbu_boot_windows__ ?? []),
        { windowId: "main", win },
      ]
    },
  }
  return installer
}

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

async function depsSignature(
  appsDir: string,
  pm: PackageManagerSpec,
): Promise<string> {
  const hash = crypto.createHash("sha256")
  await fileHash(hash, path.join(appsDir, "package.json"))
  await fileHash(hash, path.join(appsDir, lockfileFor(pm.type)))
  hash.update(`${pm.type}@${pm.version}`)
  hash.update("\0")
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

/**
 * Resolve the entrypoint we'll exec for a given PM, mirroring the layout
 * `provisionToolchain` writes into the bundle's `Resources/toolchain/`.
 */
function bundledPmEntry(pm: PackageManagerSpec):
  | { kind: "bin"; path: string }
  | { kind: "js"; path: string }
  | { kind: "bun" } {
  switch (pm.type) {
    case "pnpm": {
      const p = path.join(
        RESOURCES_PATH,
        "toolchain",
        "pnpm",
        "bin",
        "pnpm.cjs",
      )
      if (!existsSync(p)) {
        throw new Error(
          `bundled pnpm entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "npm": {
      const p = path.join(RESOURCES_PATH, "toolchain", "npm", "bin", "npm-cli.js")
      if (!existsSync(p)) {
        throw new Error(
          `bundled npm entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "yarn": {
      if (isYarnBerry(pm.version)) {
        const p = path.join(RESOURCES_PATH, "toolchain", "yarn.cjs")
        if (!existsSync(p)) {
          throw new Error(
            `bundled yarn (berry) entry not found at ${p}. The .app's toolchain is incomplete.`,
          )
        }
        return { kind: "js", path: p }
      }
      const p = path.join(RESOURCES_PATH, "toolchain", "yarn", "bin", "yarn.js")
      if (!existsSync(p)) {
        throw new Error(
          `bundled yarn (classic) entry not found at ${p}. The .app's toolchain is incomplete.`,
        )
      }
      return { kind: "js", path: p }
    }
    case "bun":
      return { kind: "bun" }
  }
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

function buildInstallEnv(appsDir: string): NodeJS.ProcessEnv {
  const target = electronTargetVersion(appsDir)
  return {
    ...process.env,
    CI: "true",
    HOME: path.join(appsDir, ".zenbu", ".node-gyp"),
    npm_config_runtime: "electron",
    npm_config_target: target,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: process.arch,
  }
}

/**
 * Best-effort progress regex per package manager. We pass each stdout line
 * through these and emit a `progress` event when one matches; otherwise
 * the line is forwarded as a `message` only. Failing to match is fine —
 * the UI just won't show fine-grained progress for that PM.
 *
 * No generic `N/M` fallback: it false-positives on common log lines like
 * `package@1.2.3/4.5.6` or unrelated paths/version strings, which would
 * make the progress bar jump around for no reason.
 */
const PNPM_RESOLVED_RE = /Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+)/i
function parseInstallProgress(
  pm: PackageManagerSpec["type"],
  line: string,
): ProgressPayload | null {
  if (pm === "pnpm") {
    const m = line.match(PNPM_RESOLVED_RE)
    if (m) {
      const resolved = parseInt(m[1]!, 10)
      const reused = parseInt(m[2]!, 10)
      const downloaded = parseInt(m[3]!, 10)
      if (Number.isFinite(resolved) && Number.isFinite(reused) && Number.isFinite(downloaded)) {
        return {
          phase: "resolve",
          loaded: reused + downloaded,
          total: resolved,
          ratio: resolved > 0 ? (reused + downloaded) / resolved : undefined,
        }
      }
    }
  }
  return null
}

function spawnInstall(
  bin: string,
  args: string[],
  appsDir: string,
  env: NodeJS.ProcessEnv,
  label: string,
  installer: Installer | null,
  pmType: PackageManagerSpec["type"],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // When there's no installer, keep the original stdio: "inherit" so
    // logs flow through the launcher's stream-patching path. When there
    // IS an installer, we pipe so we can split into lines, forward to the
    // log, AND emit IPC events.
    const useInstaller = installer != null
    const child = spawn(bin, args, {
      cwd: appsDir,
      stdio: useInstaller ? ["inherit", "pipe", "pipe"] : "inherit",
      env,
    })
    if (useInstaller) {
      const wireStream = (
        stream: NodeJS.ReadableStream | null,
        prefix: string,
      ): void => {
        if (!stream) return
        let buf = ""
        stream.setEncoding("utf8")
        stream.on("data", (chunk: string) => {
          buf += chunk
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const rawLine = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            const line = rawLine.replace(/\r/g, "").trimEnd()
            try { _logStream.write(prefix + rawLine + "\n") } catch {}
            if (!line) continue
            installer.message(line)
            const progress = parseInstallProgress(pmType, line)
            if (progress) installer.progress(progress)
          }
        })
        stream.on("end", () => {
          if (buf.length > 0) {
            try { _logStream.write(prefix + buf) } catch {}
            const line = buf.replace(/\r/g, "").trimEnd()
            if (line) installer.message(line)
          }
        })
      }
      wireStream(child.stdout, "")
      wireStream(child.stderr, "[ERR] ")
    }
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exited with code ${code}`))
    })
  })
}

async function runInstall(
  appsDir: string,
  pm: PackageManagerSpec,
  installer: Installer | null,
): Promise<void> {
  const env = buildInstallEnv(appsDir)
  const entry = bundledPmEntry(pm)

  switch (pm.type) {
    case "pnpm": {
      // pnpm respects CI=true for non-interactive mode; --reporter=append-only
      // keeps stdout sane when stdio is piped to a closed launchd handle.
      // We run via bundled bun so that ALL pnpm versions work (the npm
      // registry tarball is integrity-verified at build time, whereas the
      // standalone GitHub binary only carries attestation digests for
      // recent releases).
      if (entry.kind !== "js") throw new Error("internal: pnpm entry shape")
      const bun = bundledToolPath("bun")
      if (!bun)
        throw new Error(
          `bundled bun not found in ${RESOURCES_PATH}/toolchain (required to host the pnpm.cjs entry)`,
        )
      await spawnInstall(
        bun,
        [entry.path, "install", "--reporter=append-only"],
        appsDir,
        env,
        "pnpm install",
        installer,
        pm.type,
      )
      return
    }
    case "npm": {
      if (entry.kind !== "js") throw new Error("internal: npm entry shape")
      const bun = bundledToolPath("bun")
      if (!bun)
        throw new Error(
          `bundled bun not found in ${RESOURCES_PATH}/toolchain (required to host the npm-cli.js entry)`,
        )
      await spawnInstall(
        bun,
        [entry.path, "install", "--no-audit", "--no-fund", "--no-progress"],
        appsDir,
        env,
        "npm install",
        installer,
        pm.type,
      )
      return
    }
    case "yarn": {
      if (entry.kind !== "js") throw new Error("internal: yarn entry shape")
      const bun = bundledToolPath("bun")
      if (!bun)
        throw new Error(
          `bundled bun not found in ${RESOURCES_PATH}/toolchain (required to host the yarn.js entry)`,
        )
      if (isYarnBerry(pm.version)) {
        // Berry: `--immutable=false` is invalid syntax — toggle via env
        // instead so we don't fail on lockfile drift at first launch.
        await spawnInstall(
          bun,
          [entry.path, "install"],
          appsDir,
          { ...env, YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
          `yarn install (${pm.version})`,
          installer,
          pm.type,
        )
      } else {
        // Classic (yarn 1.x): bun's https response object doesn't expose
        // `socket.authorized`, which yarn 1.x checks unconditionally when
        // strictSSL is true; the check throws "does not support SSL" even
        // though the actual TLS handshake succeeded. Workaround: hand
        // yarn a tiny `.yarnrc` that turns strictSSL off — the underlying
        // TLS connection is still encrypted. We point at an external file
        // (NOT the source tree) so we don't pollute the user's repo.
        const rcPath = path.join(
          appsDir,
          ".zenbu",
          "yarn-classic-bun.yarnrc",
        )
        await fsp.mkdir(path.dirname(rcPath), { recursive: true })
        await fsp.writeFile(rcPath, "strict-ssl false\n")
        await spawnInstall(
          bun,
          [
            entry.path,
            "install",
            "--non-interactive",
            "--no-progress",
            "--network-timeout",
            "600000",
            "--use-yarnrc",
            rcPath,
            "--registry",
            "https://registry.npmjs.org/",
          ],
          appsDir,
          env,
          `yarn install (${pm.version})`,
          installer,
          pm.type,
        )
      }
      return
    }
    case "bun": {
      const bun = bundledToolPath("bun")
      if (!bun)
        throw new Error(
          `bundled bun not found in ${RESOURCES_PATH}/toolchain. The .app is missing required toolchain binaries.`,
        )
      await spawnInstall(
        bun,
        ["install", "--no-progress"],
        appsDir,
        env,
        "bun install",
        installer,
        pm.type,
      )
      return
    }
  }
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

async function cloneMirror(
  dir: string,
  mirror: MirrorRef,
  installer: Installer | null,
): Promise<void> {
  console.log(`[launcher] cloning ${mirror.url}#${mirror.branch} -> ${dir}`)
  installer?.step("clone", `Cloning ${mirror.url}#${mirror.branch}`)
  await fsp.mkdir(dir, { recursive: true })
  await git.clone({
    fs,
    http,
    dir,
    url: mirror.url,
    ref: mirror.branch,
    singleBranch: true,
    depth: 1,
    onProgress: installer
      ? (e) => {
          const ratio = e.total ? e.loaded / e.total : undefined
          installer.progress({
            phase: e.phase,
            loaded: e.loaded,
            total: e.total,
            ratio,
          })
        }
      : undefined,
    onMessage: installer
      ? (msg) => installer.message(msg.replace(/\n+$/g, ""))
      : undefined,
  })
  console.log(`[launcher] clone complete`)
  installer?.done("clone")
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
async function fetchAndUpdate(
  dir: string,
  mirror: MirrorRef,
  installer: Installer | null,
): Promise<void> {
  installer?.step("fetch", `Updating from ${mirror.url}#${mirror.branch}`)
  // The fetch path has multiple early returns (fetch failure, refs
  // unresolvable, already up-to-date, local modifications). All of them
  // should mark the step as done so the UI doesn't sit on "Updating…"
  // forever. We only fail-emit when the fast-forward checkout itself
  // throws (post-fetch unrecoverable state).
  try {
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
        onProgress: installer
          ? (e) => {
              const ratio = e.total ? e.loaded / e.total : undefined
              installer.progress({
                phase: e.phase,
                loaded: e.loaded,
                total: e.total,
                ratio,
              })
            }
          : undefined,
        onMessage: installer
          ? (msg) => installer.message(msg.replace(/\n+$/g, ""))
          : undefined,
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
  } finally {
    installer?.done("fetch")
  }
}

async function ensureAppsDir(
  appsDir: string,
  mirror: MirrorRef,
  installer: Installer | null,
): Promise<void> {
  if (isExistingClone(appsDir)) {
    await fetchAndUpdate(appsDir, mirror, installer)
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
  await cloneMirror(appsDir, mirror, installer)
}

async function ensureDepsInstalled(
  appsDir: string,
  pm: PackageManagerSpec,
  installer: Installer | null,
): Promise<void> {
  const sigPath = path.join(appsDir, ".zenbu", "deps-sig")
  const nodeModules = path.join(appsDir, "node_modules")
  const nextSig = await depsSignature(appsDir, pm)

  if (existsSync(nodeModules)) {
    try {
      const current = await fsp.readFile(sigPath, "utf8")
      if (current === nextSig) return
    } catch {}
  }

  console.log(
    `[launcher] installing deps in ${appsDir} via ${pm.type}@${pm.version}`,
  )
  installer?.step("install", `Installing dependencies (${pm.type}@${pm.version})`)
  await runInstall(appsDir, pm, installer)
  await fsp.mkdir(path.dirname(sigPath), { recursive: true })
  await fsp.writeFile(sigPath, nextSig)
  installer?.done("install")
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
  // Pop the installing window before any clone/install work so the user
  // sees something the moment the app launches. No-op when the user
  // didn't ship `<uiEntrypoint>/installing.html`.
  const installer = await maybeOpenInstallingWindow(cfg)

  try {
    const mirror = resolveMirror(cfg)
    const appsDir = appsDirFor(cfg.name)
    const pm = cfg.packageManager ?? LEGACY_PACKAGE_MANAGER

    await ensureAppsDir(appsDir, mirror, installer)
    await ensureDepsInstalled(appsDir, pm, installer)

    installer?.step("handoff", "Starting app")
    // Hand the BaseWindow off to setup-gate via __zenbu_boot_windows__;
    // setup-gate's spawnSplashWindow adopts it and swaps the WebContentsView
    // from installing.html to splash.html in place.
    installer?.handoff()
    await handoff(appsDir)
  } catch (err) {
    // installer.fail() reads installer.currentStep when no explicit id is
    // passed, so the page sees `{ id: "clone" | "fetch" | "install" | "handoff" }`
    // matching whichever phase was active when it threw.
    installer?.fail(err)
    throw err
  }
}

main().catch((err) => {
  console.error("[launcher] fatal:", err)
  app.exit(1)
})
