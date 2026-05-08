import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { findBuildConfig, loadBuildConfig } from "../lib/load-build-config"
import { initSeedRepo } from "../lib/mirror-sync"
import type { ResolvedBuildConfig } from "../lib/build-config"
import { readConfig, type ZenbuConfig } from "../lib/config"

interface DesktopBuildFlags {
  config?: string
  out?: string
  noSource: boolean
  noSign: boolean
  target?: string[]
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

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) return cwd
  console.error("zen build:desktop: no zenbu.plugin.json found in current directory")
  process.exit(1)
}

function parseFlags(argv: string[]): DesktopBuildFlags {
  const flags: DesktopBuildFlags = { noSource: false, noSign: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--config" || arg === "-c") flags.config = argv[++i]
    else if (arg.startsWith("--config=")) flags.config = arg.slice("--config=".length)
    else if (arg === "--out" || arg === "-o") flags.out = argv[++i]
    else if (arg.startsWith("--out=")) flags.out = arg.slice("--out=".length)
    else if (arg === "--no-source") flags.noSource = true
    else if (arg === "--no-sign") flags.noSign = true
    else if (arg === "--target" || arg === "-t") {
      flags.target = (argv[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--target=")) {
      flags.target = arg.slice("--target=".length).split(",").filter(Boolean)
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

function resolveCliVersion(): string {
  try {
    const localRequire = createRequire(import.meta.url)
    const pkgPath = localRequire.resolve("@zenbujs/cli/package.json")
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
        if (pkg.name === "@zenbujs/cli" && pkg.version) return pkg.version
        if (pkg.version) return pkg.version
      }
      dir = path.dirname(dir)
    }
  } catch {}
  return "0.0.0"
}

function resolveBundledLauncher(projectDir: string): string {
  const localRequire = createRequire(path.join(projectDir, "package.json"))
  try {
    const pkgPath = localRequire.resolve("@zenbujs/cli/package.json")
    const launcher = path.join(path.dirname(pkgPath), "dist", "launcher.mjs")
    if (fs.existsSync(launcher)) return launcher
  } catch {}
  const here = fileURLToPath(import.meta.url)
  const candidate = path.resolve(path.dirname(here), "..", "..", "launcher.mjs")
  if (fs.existsSync(candidate)) return candidate
  throw new Error(
    "zen build:desktop: cannot locate `@zenbujs/cli/dist/launcher.mjs`. " +
      "Make sure @zenbujs/cli is installed in this project (or run from the framework's monorepo).",
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
    "zen build:desktop: electron-builder not found in node_modules. " +
      "Add it to devDependencies and run `pnpm install`.",
  )
}

interface AppConfigJson {
  name: string
  mirrorUrl: string | null
  branch: string
  version: string
  host: string
}

async function ensureSource(projectDir: string, config: ResolvedBuildConfig, noSource: boolean): Promise<StagingMeta> {
  const stagingDir = path.resolve(projectDir, config.out)
  const shaPath = path.join(stagingDir, ".sha")

  const currentSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf8" }).trim()
    } catch {
      return "uncommitted"
    }
  })()

  if (fs.existsSync(shaPath)) {
    const meta = readJson<StagingMeta>(shaPath)
    if (meta.sourceSha === currentSha) return meta
    if (noSource) {
      console.warn(
        `[build:desktop] --no-source: using stale staging (built from ${meta.sourceSha.slice(0, 7)}, current HEAD ${currentSha.slice(0, 7)})`,
      )
      return meta
    }
  }

  if (noSource) {
    console.error(
      "zen build:desktop: --no-source given but no staging found. Run `zen build:source` first.",
    )
    process.exit(1)
  }

  console.log(`  → running zen build:source (staging is missing or stale)`)
  const { runBuildSource } = await import("./build-source")
  await runBuildSource([])
  return readJson<StagingMeta>(shaPath)
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
}

/**
 * Stage a directory tree into a destination path with bundle-aware symlink
 * handling. See the "Stage extraResources …" comment in `buildDesktop` for
 * the why; the rules:
 *
 *   - Regular file: copy as-is, preserving execute bit.
 *   - Directory: recurse.
 *   - Symlink whose resolved target is INSIDE the source root: preserve as a
 *     symlink in the destination, rewriting the link target to be relative
 *     and pointing at the equivalent path inside the destination tree
 *     (preserves git's in-tree subcommand symlinks; codesign accepts these).
 *   - Symlink whose resolved target is OUTSIDE the source root: dereference
 *     and copy the real file/directory (so the bundle is self-contained).
 *   - Broken symlink: skipped with a warning.
 */
async function stageBundleTree(src: string, dest: string): Promise<void> {
  const srcRoot = await fsp.realpath(src)
  await fsp.mkdir(dest, { recursive: true })
  await stageBundleTreeRecursive(srcRoot, dest, srcRoot, dest)
}

async function stageBundleTreeRecursive(
  srcDir: string,
  destDir: string,
  srcRoot: string,
  destRoot: string,
): Promise<void> {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)

    if (entry.isSymbolicLink()) {
      await stageSymlink(srcPath, destPath, srcRoot, destRoot)
      continue
    }

    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true })
      await stageBundleTreeRecursive(srcPath, destPath, srcRoot, destRoot)
      continue
    }

    if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath)
      const stat = await fsp.stat(srcPath)
      await fsp.chmod(destPath, stat.mode & 0o777)
    }
  }
}

async function stageSymlink(
  srcPath: string,
  destPath: string,
  srcRoot: string,
  destRoot: string,
): Promise<void> {
  const linkTarget = await fsp.readlink(srcPath)
  const resolvedAbs = path.resolve(path.dirname(srcPath), linkTarget)

  let realTarget: string
  try {
    realTarget = await fsp.realpath(resolvedAbs)
  } catch {
    console.warn(`  ⚠ broken symlink (skipped): ${path.relative(srcRoot, srcPath)} -> ${linkTarget}`)
    return
  }

  const insideRoot = realTarget === srcRoot || realTarget.startsWith(srcRoot + path.sep)
  if (insideRoot) {
    const relInRoot = path.relative(srcRoot, realTarget)
    const equivalentInDest = path.join(destRoot, relInRoot)
    const newLinkTarget = path.relative(path.dirname(destPath), equivalentInDest)
    await fsp.symlink(newLinkTarget, destPath)
    return
  }

  // Out-of-tree symlink: materialize the real target so the bundle is
  // self-contained. Could be a file or a directory.
  let stat: import("node:fs").Stats
  try {
    stat = await fsp.stat(realTarget)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    await fsp.mkdir(destPath, { recursive: true })
    await stageBundleTreeRecursive(realTarget, destPath, realTarget, destPath)
    return
  }
  await fsp.copyFile(realTarget, destPath)
  await fsp.chmod(destPath, stat.mode & 0o777)
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

export async function runBuildDesktop(argv: string[]): Promise<void> {
  await buildDesktop(parseFlags(argv), { publish: false })
}

/**
 * Shared entrypoint for `zen build:desktop` and `zen publish:desktop`.
 * `publish` controls whether electron-builder's native GitHub publish step
 * runs at the end of the build. When true, we inject the publish provider
 * config and pass `--publish always` to electron-builder; the same single
 * invocation handles bundling, signing, notarizing, AND uploading the
 * artifacts to a GitHub release.
 */
export async function buildDesktop(
  flags: DesktopBuildFlags,
  options: { publish: boolean },
): Promise<void> {
  const projectDir = resolveProjectDir()

  const configPath = flags.config
    ? path.resolve(projectDir, flags.config)
    : findBuildConfig(projectDir)
  const config = await loadBuildConfig(configPath)

  const meta = await ensureSource(projectDir, config, flags.noSource)
  const stagingDir = path.resolve(projectDir, config.out)

  const projectPkg = readJson<{ name?: string; version?: string }>(path.join(projectDir, "package.json"))
  const appName = projectPkg.name ?? path.basename(projectDir)
  const appVersion = projectPkg.version ?? "0.0.1"

  const mirrorTarget = config.mirror?.target ?? null
  const mirrorBranch = config.mirror?.branch ?? "main"
  const mirrorUrl = mirrorTarget ? expandMirrorUrl(mirrorTarget) : null

  const desktopOut = flags.out ? path.resolve(projectDir, flags.out) : path.join(projectDir, "dist")
  // Stage outside the project tree. If we stage inside (e.g. .zenbu/desktop-staging),
  // electron-builder's "search for node_modules" walks UP from the staging dir,
  // finds the project's own node_modules, and bundles the whole devDep tree
  // into the .app's Resources/app/node_modules — even though our generated
  // package.json declares no dependencies. Staging in os.tmpdir() ends that walk
  // immediately at /tmp.
  const electronBuilderStaging = await fsp.mkdtemp(path.join(os.tmpdir(), `zenbu-desktop-${appName}-`))

  const commandLabel = options.publish ? "zen publish:desktop" : "zen build:desktop"
  console.log(`\n  ${commandLabel}`)
  console.log(`    name:    ${appName}`)
  console.log(`    version: ${appVersion}`)
  console.log(`    source:  ${meta.sourceSha === "uncommitted" ? "uncommitted" : meta.sourceSha.slice(0, 7)}`)
  console.log(`    mirror:  ${mirrorTarget ?? "(none — set config.mirror.target to enable updates)"}`)
  console.log(`    out:     ${path.relative(projectDir, desktopOut) || "."}\n`)

  console.log("  → copying launcher.mjs")
  const launcherSrc = resolveBundledLauncher(projectDir)
  await copyFile(launcherSrc, path.join(electronBuilderStaging, "launcher.mjs"))

  console.log("  → staging seed/")
  const seedDir = path.join(electronBuilderStaging, "seed")
  await fsp.cp(stagingDir, seedDir, { recursive: true, filter: (src) => path.basename(src) !== ".sha" })
  if (mirrorUrl) {
    await initSeedRepo({
      dir: seedDir,
      mirrorUrl,
      branch: mirrorBranch,
      sourceSha: meta.sourceSha === "uncommitted" ? "0000000000000000000000000000000000000000" : meta.sourceSha,
    })
  }

  console.log("  → generating bundle package.json + app-config.json")
  const host = resolveCliVersion()
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
  await fsp.writeFile(
    path.join(electronBuilderStaging, "package.json"),
    JSON.stringify(bundlePkg, null, 2) + "\n",
  )

  const appConfig: AppConfigJson = {
    name: appName,
    mirrorUrl: mirrorUrl,
    branch: mirrorBranch,
    version: appVersion,
    host,
  }
  await fsp.writeFile(
    path.join(electronBuilderStaging, "app-config.json"),
    JSON.stringify(appConfig, null, 2) + "\n",
  )

  // Stage extraResources into the desktop staging dir.
  //
  // macOS code-signing requires every symlink in a sealed bundle to resolve
  // to a path *inside the same bundle*. Two failure modes we care about:
  //   1. Absolute symlinks (e.g. `bin/git -> /abs/.zenbu/toolchain/git/bin/git`,
  //      written by the toolchain provisioning step) point at a dev-machine
  //      path that won't exist on the user's disk.
  //   2. Symlinks whose resolved target is outside the staged tree.
  //
  // Naive `cp -RL` dereferences *every* symlink, which inflated the git
  // distribution from 136MB to 613MB (145 git-subcommand symlinks all turned
  // into full copies of the same git binary). Instead we preserve relative
  // symlinks that stay inside the source root, rewrite absolute symlinks
  // that still resolve inside the source root to be relative, and only
  // dereference symlinks whose target is genuinely outside.
  const stagedResourcesDir = path.join(electronBuilderStaging, "_extra-resources")
  await fsp.mkdir(stagedResourcesDir, { recursive: true })
  const extraResources: Array<{ from: string; to: string }> = []
  for (const res of config.bundle?.extraResources ?? []) {
    const absSrc = path.resolve(projectDir, res)
    const base = path.basename(res.replace(/\/+$/, ""))
    const stagedAbs = path.join(stagedResourcesDir, base)
    console.log(`  → staging ${path.relative(projectDir, absSrc)} (preserving in-tree symlinks)`)
    await stageBundleTree(absSrc, stagedAbs)
    extraResources.push({ from: stagedAbs, to: base })
  }

  const zenbuConfig = readConfig(projectDir)
  const signingIdentity = flags.noSign ? null : pickSigningIdentity(zenbuConfig)
  const targets = flags.target ?? ["zip"]
  const wantNotarize = !flags.noSign && zenbuConfig.signing?.notarize === true

  const macConfig: Record<string, unknown> = {
    category: "public.app-category.developer-tools",
    target: targets,
  }
  if (signingIdentity) {
    macConfig.identity = signingIdentity
    macConfig.hardenedRuntime = true
    macConfig.gatekeeperAssess = false
    // electron-builder 26 expects a plain boolean here. When notarizing,
    // team ID + Apple ID + app-specific password are picked up from
    // APPLE_TEAM_ID / APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD env vars.
    macConfig.notarize = wantNotarize
  } else {
    // ad-hoc — produces a runnable .app for local use; Gatekeeper will block
    // it on download to other machines.
    macConfig.identity = "-"
    // Be explicit: electron-builder otherwise auto-enables notarization
    // when APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD are present in env, and
    // tries to notarize the ad-hoc-signed bundle (which Apple rejects with
    // "binary is not signed with a valid Developer ID certificate").
    macConfig.notarize = false
  }

  // Publish config: when `options.publish` is true and the user has a github
  // publish target in zenbu.config.json, hand electron-builder the provider
  // config and pass `--publish always`. electron-builder takes care of
  // creating/finding the GitHub release, uploading the .zip, the .blockmap,
  // and `latest-mac.yml` (for electron-updater compatibility) in one shot.
  let publishConfig: unknown = null
  if (options.publish) {
    const pub = zenbuConfig.publish
    if (!pub || pub.provider !== "github" || !pub.owner || !pub.repo) {
      throw new Error(
        "zen publish:desktop: zenbu.config.json must declare publish: { provider: 'github', owner, repo }",
      )
    }
    publishConfig = [{
      provider: "github",
      owner: pub.owner,
      repo: pub.repo,
      releaseType: "release",
    }]
  }

  const builderConfig = {
    appId:
      zenbuConfig.app?.bundleId ??
      `dev.zenbu.${appName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    productName: appName,
    asar: false,
    directories: {
      app: electronBuilderStaging,
      output: desktopOut,
      buildResources: electronBuilderStaging,
    },
    files: [
      "package.json",
      "app-config.json",
      "launcher.mjs",
      "seed/**/*",
      "!node_modules",
      "!**/node_modules",
      "!**/node_modules/**",
    ],
    extraResources,
    mac: macConfig,
    npmRebuild: false,
    publish: publishConfig,
  }

  const builderConfigPath = path.join(electronBuilderStaging, "electron-builder.json")
  await fsp.writeFile(builderConfigPath, JSON.stringify(builderConfig, null, 2) + "\n")

  if (signingIdentity) {
    console.log(`  → signing identity: ${signingIdentity}`)
  } else if (flags.noSign) {
    console.log(`  → signing: skipped (--no-sign)`)
  } else {
    console.log(`  → signing: ad-hoc (no identity configured; won't pass Gatekeeper on other machines)`)
  }
  if (wantNotarize) {
    if (!process.env.APPLE_ID) {
      console.warn("  ⚠ notarize=true but APPLE_ID env not set; notarization will fail.")
    }
    if (!process.env.APPLE_APP_SPECIFIC_PASSWORD && !process.env.APPLE_API_KEY) {
      console.warn(
        "  ⚠ notarize=true but APPLE_APP_SPECIFIC_PASSWORD / APPLE_API_KEY env not set; notarization will fail.",
      )
    }
    console.log(`  → notarize: yes (team ${zenbuConfig.signing?.teamId ?? "auto"})`)
  }
  if (options.publish) {
    const pub = zenbuConfig.publish!
    console.log(`  → publish: github ${pub.owner}/${pub.repo}`)
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
      console.warn(
        "  ⚠ publish requested but GH_TOKEN/GITHUB_TOKEN not set; the upload will fail.",
      )
    }
  }
  console.log(`  → targets: ${targets.join(", ")}`)
  console.log(`  → invoking electron-builder${options.publish ? " --publish always" : ""}`)
  const electronBuilder = resolveElectronBuilder(projectDir)
  const env = { ...process.env }
  if (zenbuConfig.signing?.teamId) env.APPLE_TEAM_ID = zenbuConfig.signing.teamId
  // electron-builder reads GH_TOKEN preferentially; mirror GITHUB_TOKEN onto it
  // so users can use either env var name.
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN

  const cliArgs = ["--config", builderConfigPath]
  if (options.publish) cliArgs.push("--publish", "always")

  if (electronBuilder.endsWith(".js")) {
    await spawnAsync(process.execPath, [electronBuilder, ...cliArgs], projectDir, env)
  } else {
    await spawnAsync(electronBuilder, cliArgs, projectDir, env)
  }

  console.log(
    `\n  ✓ ${options.publish ? "Published" : "Built"} ${appName} ${appVersion}` +
      ` at ${path.relative(projectDir, desktopOut) || "."}\n`,
  )
}

/**
 * electron-builder rejects identity strings prefixed with `Developer ID Application:`,
 * insisting on the bare common-name portion (e.g. `Robert Pruzan (7YBC6H852Y)`).
 * We strip it here so users can paste the full keychain name into
 * `zenbu.config.json` and it still works.
 */
function normalizeIdentity(identity: string): string {
  if (/^[0-9A-F]{40}$/i.test(identity.trim())) return identity.trim().toUpperCase()
  return identity.replace(/^Developer ID Application:\s*/i, "").trim()
}

function pickSigningIdentity(zenbuConfig: ZenbuConfig): string | null {
  const raw =
    zenbuConfig.signing?.identity ??
    process.env.CSC_NAME ??
    autoDetectSigningIdentity()
  return raw ? normalizeIdentity(raw) : null
}

function autoDetectSigningIdentity(): string | null {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    })
    const lines = out.split("\n")
    for (const line of lines) {
      const match = line.match(/"(Developer ID Application:[^"]+)"/)
      if (match) return match[1]!
    }
  } catch {}
  return null
}
