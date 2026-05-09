import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { findBuildConfig, loadBuildConfig } from "../lib/load-build-config"
import { initSeedRepo } from "../lib/mirror-sync"
import { provisionToolchain } from "../lib/toolchain"
import type { ResolvedBuildConfig } from "../lib/build-config"

interface BuildElectronFlags {
  config?: string
  noSource: boolean
  passthrough: string[]
}

interface StagingMeta {
  sourceSha: string
  contentHash: string
  builtAt: string
}

interface BundlePackageJson {
  name: string
  version: string
  main: string
  type: string
  repository?: { type: "git"; url: string }
  zenbu?: { host?: string }
}

interface AppConfigJson {
  name: string
  mirrorUrl: string | null
  branch: string
  version: string
  host: string
}

interface ElectronBuilderConfig {
  appId?: string
  productName?: string
  asar?: boolean
  directories?: {
    app?: string
    output?: string
    buildResources?: string
  }
  files?: unknown
  extraResources?: unknown
  mac?: Record<string, unknown>
  win?: Record<string, unknown>
  linux?: Record<string, unknown>
  publish?: unknown
  npmRebuild?: boolean
  [key: string]: unknown
}

const ELECTRON_BUILDER_CONFIG_NAMES = [
  "electron-builder.json",
  "electron-builder.json5",
  "electron-builder.yml",
  "electron-builder.yaml",
  "electron-builder.config.js",
  "electron-builder.config.cjs",
  "electron-builder.config.mjs",
]

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) return cwd
  console.error("zen build:electron: no zenbu.plugin.json found in current directory")
  process.exit(1)
}

/**
 * Args use `--` to delimit zen flags from electron-builder pass-through
 * flags. e.g. `pnpm build:electron -- --publish always` forwards
 * `--publish always` to electron-builder. Without `--` everything is treated
 * as a zen flag (and unknown flags error out).
 */
function parseFlags(argv: string[]): BuildElectronFlags {
  const flags: BuildElectronFlags = { noSource: false, passthrough: [] }
  let sawSeparator = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (sawSeparator) {
      flags.passthrough.push(arg)
      continue
    }
    if (arg === "--") {
      sawSeparator = true
      continue
    }
    if (arg === "--config" || arg === "-c") flags.config = argv[++i]
    else if (arg.startsWith("--config=")) flags.config = arg.slice("--config=".length)
    else if (arg === "--no-source") flags.noSource = true
    else {
      console.error(`zen build:electron: unknown flag "${arg}"`)
      console.error(`valid: zen build:electron [--config <zenbu.build.ts>] [--no-source] [-- <electron-builder args>]`)
      process.exit(1)
    }
  }
  return flags
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

function expandMirrorUrl(target: string): string {
  if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("git@")) {
    return target
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    return `https://github.com/${target}.git`
  }
  return target
}

function resolveCoreVersion(): string {
  try {
    const localRequire = createRequire(import.meta.url)
    const pkgPath = localRequire.resolve("@zenbujs/core/package.json")
    const pkg = readJson<{ version?: string }>(pkgPath)
    if (pkg.version) return pkg.version
  } catch {}
  try {
    const here = fileURLToPath(import.meta.url)
    let dir = path.dirname(here)
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "package.json")
      if (fs.existsSync(candidate)) {
        const pkg = readJson<{ name?: string; version?: string }>(candidate)
        if (pkg.name === "@zenbujs/core" && pkg.version) return pkg.version
        if (pkg.version) return pkg.version
      }
      dir = path.dirname(dir)
    }
  } catch {}
  return "0.0.0"
}

/**
 * Find the bundled `launcher.mjs` shipped inside `@zenbujs/core/dist/`. We
 * resolve it through Node's resolution from the user's project so that the
 * launcher matches the version of `@zenbujs/core` actually installed in the
 * app's `node_modules` (which is what runs in the bundled .app).
 */
function resolveLauncher(projectDir: string): string {
  const localRequire = createRequire(path.join(projectDir, "package.json"))
  try {
    const pkgPath = localRequire.resolve("@zenbujs/core/package.json")
    const launcher = path.join(path.dirname(pkgPath), "dist", "launcher.mjs")
    if (fs.existsSync(launcher)) return launcher
  } catch {}
  // Fallback: same directory as our compiled CLI bin (when running from the
  // monorepo's tsdown output, dist/cli/build-electron.mjs sits next to
  // dist/launcher.mjs).
  const here = fileURLToPath(import.meta.url)
  const candidate = path.resolve(path.dirname(here), "..", "launcher.mjs")
  if (fs.existsSync(candidate)) return candidate
  throw new Error(
    "zen build:electron: cannot locate `@zenbujs/core/dist/launcher.mjs`. " +
      "Make sure @zenbujs/core is installed in this project.",
  )
}

function resolveElectronBuilder(projectDir: string): string {
  const candidates = [
    path.join(projectDir, "node_modules", ".bin", "electron-builder"),
    path.join(projectDir, "node_modules", "electron-builder", "out", "cli", "cli.js"),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    "zen build:electron: electron-builder not found in node_modules. " +
      "Add it to devDependencies and run `pnpm install`.",
  )
}

function findElectronBuilderConfig(projectDir: string): { path: string; format: "json" | "other" } | null {
  for (const name of ELECTRON_BUILDER_CONFIG_NAMES) {
    const candidate = path.join(projectDir, name)
    if (fs.existsSync(candidate)) {
      return { path: candidate, format: name.endsWith(".json") ? "json" : "other" }
    }
  }
  const pkgPath = path.join(projectDir, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = readJson<{ build?: ElectronBuilderConfig }>(pkgPath)
      if (pkg.build) return { path: pkgPath, format: "json" }
    } catch {}
  }
  return null
}

function readElectronBuilderConfig(projectDir: string): ElectronBuilderConfig {
  const found = findElectronBuilderConfig(projectDir)
  if (!found) {
    throw new Error(
      [
        "zen build:electron: no electron-builder config found.",
        "",
        "Create `electron-builder.json` in the project root, e.g.:",
        "",
        '  {',
        '    "appId": "dev.you.your-app",',
        '    "productName": "Your App",',
        '    "asar": false,',
        '    "directories": { "output": "dist" },',
        '    "mac": { "category": "public.app-category.developer-tools", "target": ["zip"] }',
        '  }',
        "",
      ].join("\n"),
    )
  }
  if (found.format !== "json") {
    throw new Error(
      `zen build:electron: only JSON electron-builder configs are supported right now (got ${path.basename(found.path)}). ` +
        `Convert to electron-builder.json or move the config under package.json#build.`,
    )
  }
  if (path.basename(found.path) === "package.json") {
    const pkg = readJson<{ build?: ElectronBuilderConfig }>(found.path)
    return { ...(pkg.build ?? {}) }
  }
  return readJson<ElectronBuilderConfig>(found.path)
}

async function ensureSource(
  projectDir: string,
  config: ResolvedBuildConfig,
  noSource: boolean,
): Promise<StagingMeta> {
  const stagingDir = path.resolve(projectDir, config.out)
  const shaPath = path.join(stagingDir, ".sha")

  const currentSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: projectDir,
        encoding: "utf8",
      }).trim()
    } catch {
      return "uncommitted"
    }
  })()

  if (fs.existsSync(shaPath)) {
    const meta = readJson<StagingMeta>(shaPath)
    if (meta.sourceSha === currentSha) return meta
    if (noSource) {
      console.warn(
        `[build:electron] --no-source: using stale staging (built from ${meta.sourceSha.slice(0, 7)}, current HEAD ${currentSha.slice(0, 7)})`,
      )
      return meta
    }
  }

  if (noSource) {
    console.error(
      "zen build:electron: --no-source given but no staging found. Run `zen build:source` first.",
    )
    process.exit(1)
  }

  console.log(`  → running zen build:source (seed is missing or stale)`)
  const { runBuildSource } = await import("./build-source")
  await runBuildSource([])
  return readJson<StagingMeta>(shaPath)
}

async function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

/**
 * Compose the user's electron-builder config with the zenbu overlays. The
 * overlays are minimal and targeted:
 *
 *   - `directories.app`        owned by zen — points at our staged app dir
 *   - `files`                  owned by zen — the staged app dir is fully
 *                              under our control, so user-side `files`
 *                              entries would not resolve anyway
 *   - `extraResources`         additive — we APPEND the toolchain entry to
 *                              whatever the user already declared
 *   - `npmRebuild`             forced to false — the seed ships its own
 *                              lockfile and `pnpm install` runs at first
 *                              launch, no rebuild step needed at build time
 *
 * Everything else (`appId`, `productName`, `mac`, `win`, `linux`,
 * `publish`, `directories.output`, `directories.buildResources`, `asar`,
 * signing/notarize, target list) is preserved as-is from the user's config.
 */
function mergeElectronBuilderConfig(
  userConfig: ElectronBuilderConfig,
  overlay: {
    appDir: string
    output: string
    seedFiles: string[]
    extraResource: { from: string; to: string }
  },
): ElectronBuilderConfig {
  const merged: ElectronBuilderConfig = { ...userConfig }
  merged.directories = {
    ...(userConfig.directories ?? {}),
    app: overlay.appDir,
    output: overlay.output,
  }
  merged.files = overlay.seedFiles
  const userExtra = Array.isArray(userConfig.extraResources)
    ? (userConfig.extraResources as Array<{ from: string; to: string } | string>)
    : []
  merged.extraResources = [...userExtra, overlay.extraResource]
  if (userConfig.npmRebuild !== false) merged.npmRebuild = false
  if (userConfig.asar === undefined) merged.asar = false
  return merged
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
}

export async function runBuildElectron(argv: string[]): Promise<void> {
  const projectDir = resolveProjectDir()
  const flags = parseFlags(argv)

  const configPath = flags.config
    ? path.resolve(projectDir, flags.config)
    : findBuildConfig(projectDir)
  const config = await loadBuildConfig(configPath)

  const meta = await ensureSource(projectDir, config, flags.noSource)
  const seedDir = path.resolve(projectDir, config.out)

  // Stage the bundle outside the project tree. If we stage inside (e.g.
  // `.zenbu/build/electron/`), electron-builder walks UP looking for
  // `node_modules` and ends up bundling the project's whole devDep tree
  // into Resources/app/node_modules even though our generated bundle
  // package.json declares no deps. Using os.tmpdir() ends that walk
  // immediately at /tmp.
  const projectPkg = readJson<{ name?: string; version?: string }>(
    path.join(projectDir, "package.json"),
  )
  const appName = projectPkg.name ?? path.basename(projectDir)
  const appVersion = projectPkg.version ?? "0.0.1"

  const bundleDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `zenbu-electron-${appName}-`),
  )
  const stagedSeed = path.join(bundleDir, "seed")
  const toolchainDir = path.join(bundleDir, "toolchain")
  const launcherOut = path.join(bundleDir, "launcher.mjs")
  const bundlePkgOut = path.join(bundleDir, "package.json")
  const appConfigOut = path.join(bundleDir, "app-config.json")
  const mergedConfigPath = path.join(bundleDir, "electron-builder.merged.json")

  const mirrorTarget = config.mirror?.target ?? null
  const mirrorBranch = config.mirror?.branch ?? "main"
  const mirrorUrl = mirrorTarget ? expandMirrorUrl(mirrorTarget) : null

  console.log(`\n  zen build:electron`)
  console.log(`    name:    ${appName}`)
  console.log(`    version: ${appVersion}`)
  console.log(`    source:  ${meta.sourceSha === "uncommitted" ? "uncommitted" : meta.sourceSha.slice(0, 7)}`)
  console.log(`    mirror:  ${mirrorTarget ?? "(none — set config.mirror.target to enable updates)"}`)
  console.log(`    bundle:  ${bundleDir}`)

  console.log("  → staging launcher.mjs")
  const launcherSrc = resolveLauncher(projectDir)
  await copyFile(launcherSrc, launcherOut)

  console.log("  → staging seed/")
  await fsp.cp(seedDir, stagedSeed, {
    recursive: true,
    filter: (src) => path.basename(src) !== ".sha",
  })
  if (mirrorUrl) {
    await initSeedRepo({
      dir: stagedSeed,
      mirrorUrl,
      branch: mirrorBranch,
      sourceSha:
        meta.sourceSha === "uncommitted"
          ? "0000000000000000000000000000000000000000"
          : meta.sourceSha,
    })
  }

  console.log("  → provisioning bundled toolchain (bun + pnpm)")
  await provisionToolchain(toolchainDir)

  console.log("  → writing bundle package.json + app-config.json")
  const host = resolveCoreVersion()
  const bundlePkg: BundlePackageJson = {
    name: appName,
    version: appVersion,
    main: "launcher.mjs",
    type: "module",
    zenbu: { host },
  }
  if (mirrorUrl) {
    bundlePkg.repository = { type: "git", url: mirrorUrl }
  }
  await fsp.writeFile(bundlePkgOut, JSON.stringify(bundlePkg, null, 2) + "\n")

  const appConfig: AppConfigJson = {
    name: appName,
    mirrorUrl,
    branch: mirrorBranch,
    version: appVersion,
    host,
  }
  await fsp.writeFile(appConfigOut, JSON.stringify(appConfig, null, 2) + "\n")

  const userConfig = readElectronBuilderConfig(projectDir)
  // Resolve `directories.output` to an absolute path BEFORE we hand it to
  // electron-builder. The user's config likely says `dist` (project-relative),
  // but electron-builder resolves it relative to `directories.app` — which
  // we just rewrote to an os.tmpdir() path. Without this, the .app would
  // land in `<tmpdir>/dist/` instead of the user's project.
  const userOutput = userConfig.directories?.output ?? "dist"
  const resolvedOutput = path.isAbsolute(userOutput)
    ? userOutput
    : path.resolve(projectDir, userOutput)

  const merged = mergeElectronBuilderConfig(userConfig, {
    appDir: bundleDir,
    output: resolvedOutput,
    seedFiles: [
      "package.json",
      "app-config.json",
      "launcher.mjs",
      "seed/**/*",
      "!node_modules",
      "!**/node_modules",
      "!**/node_modules/**",
    ],
    extraResource: {
      from: toolchainDir,
      to: "toolchain",
    },
  })
  await fsp.writeFile(mergedConfigPath, JSON.stringify(merged, null, 2) + "\n")

  console.log("  → injected into electron-builder config:")
  console.log(`      directories.app    = ${bundleDir}`)
  console.log(`      directories.output = ${resolvedOutput}`)
  console.log(`      files              = [zenbu seed]`)
  console.log(`      extraResources    += { from: <bundle>/toolchain, to: toolchain }`)
  console.log(`      asar               = ${merged.asar !== undefined ? merged.asar : "(unset)"}`)
  console.log(`      npmRebuild         = false`)

  console.log("  → invoking electron-builder")
  const electronBuilder = resolveElectronBuilder(projectDir)
  const cliArgs = ["--config", mergedConfigPath, ...flags.passthrough]
  const env = { ...process.env }
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN

  if (electronBuilder.endsWith(".js")) {
    await spawnAsync(process.execPath, [electronBuilder, ...cliArgs], projectDir, env)
  } else {
    await spawnAsync(electronBuilder, cliArgs, projectDir, env)
  }

  console.log(`\n  ✓ Built ${appName} ${appVersion} at ${path.relative(projectDir, resolvedOutput) || resolvedOutput}\n`)
}
