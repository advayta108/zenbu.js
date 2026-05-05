import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFile, execFileSync } from "node:child_process"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { createWriteStream } from "node:fs"
import { findInstalledVersion, getElectronBinary, getRuntimeDir } from "./runtime"
import { ensureAppConfig, ensureSigningConfig, readConfig } from "../lib/config"

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  if (!response.body) throw new Error("No response body")
  const readable = Readable.fromWeb(response.body as any)
  await pipeline(readable, createWriteStream(dest))
}

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) return cwd
  console.error("zen build: no zenbu.plugin.json found in current directory")
  process.exit(1)
}

function getGitRemote(projectDir: string): string {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim()
  } catch {
    console.error("zen build: no git remote 'origin' found. Push your project to a git repo first.")
    process.exit(1)
  }
}

function getGitBranch(projectDir: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim() || "main"
  } catch {
    return "main"
  }
}

function parseFlags(argv: string[]): { out: string | null; runtimeVersion: string | null } {
  let out: string | null = null
  let runtimeVersion: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--out" || arg === "-o") out = argv[++i] ?? null
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length)
    else if (arg === "--runtime" || arg === "-r") runtimeVersion = argv[++i] ?? null
    else if (arg.startsWith("--runtime=")) runtimeVersion = arg.slice("--runtime=".length)
  }

  return { out, runtimeVersion }
}

async function downloadToolchain(stagingDir: string, versionsPath: string) {
  const toolchainDir = path.join(stagingDir, "toolchain")
  fs.mkdirSync(toolchainDir, { recursive: true })

  let versions: any
  try {
    versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"))
  } catch {
    console.error(`zen build: cannot read ${versionsPath}`)
    process.exit(1)
  }

  const arch = os.arch()
  const bunTarget = arch === "arm64" ? "darwin-aarch64" : "darwin-x64"
  const pnpmTarget = arch === "arm64" ? "darwin-arm64" : "darwin-x64"

  const bunInfo = versions.bun.targets[bunTarget]
  const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${versions.bun.version}/${bunInfo.asset}`
  const bunZip = path.join(os.tmpdir(), `zenbu-build-bun-${crypto.randomBytes(4).toString("hex")}.zip`)

  console.log(`  → downloading bun ${versions.bun.version}...`)
  await download(bunUrl, bunZip)
  const extractDir = path.join(os.tmpdir(), `zenbu-build-bun-extract-${Date.now()}`)
  fs.mkdirSync(extractDir, { recursive: true })
  execFileSync("unzip", ["-q", bunZip, "-d", extractDir])
  const bunBin = findFile(extractDir, "bun")
  if (bunBin) {
    fs.copyFileSync(bunBin, path.join(toolchainDir, "bun"))
    fs.chmodSync(path.join(toolchainDir, "bun"), 0o755)
  }
  fs.rmSync(extractDir, { recursive: true, force: true })
  try { fs.unlinkSync(bunZip) } catch {}

  const pnpmInfo = versions.pnpm.targets[pnpmTarget]
  const pnpmUrl = `https://github.com/pnpm/pnpm/releases/download/v${versions.pnpm.version}/${pnpmInfo.asset}`
  console.log(`  → downloading pnpm ${versions.pnpm.version}...`)
  await download(pnpmUrl, path.join(toolchainDir, "pnpm"))
  fs.chmodSync(path.join(toolchainDir, "pnpm"), 0o755)

  if (versions.git) {
    const gitTarget = arch === "arm64" ? "darwin-arm64" : "darwin-x64"
    const gitInfo = versions.git.targets[gitTarget]
    if (gitInfo?.url) {
      const gitTar = path.join(os.tmpdir(), `zenbu-build-git-${crypto.randomBytes(4).toString("hex")}.tar.gz`)
      console.log(`  → downloading git ${versions.git.version}...`)
      await download(gitInfo.url, gitTar)
      const gitExtractDir = path.join(toolchainDir, "git")
      fs.mkdirSync(gitExtractDir, { recursive: true })
      execFileSync("tar", ["-xzf", gitTar, "-C", gitExtractDir])
      try { fs.unlinkSync(gitTar) } catch {}
    }
  }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name === name) return full
  }
  return null
}

export async function runBuild(argv: string[]) {
  const projectDir = resolveProjectDir()
  const flags = parseFlags(argv)

  const appConfig = await ensureAppConfig(projectDir)
  const signingConfig = await ensureSigningConfig(projectDir)

  const name = appConfig.name!
  const bundleId = appConfig.bundleId ?? `dev.zenbu.${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
  const out = flags.out ?? path.join(projectDir, "dist")

  let runtimeVersion = flags.runtimeVersion
  if (!runtimeVersion) {
    try {
      const pluginManifest = JSON.parse(fs.readFileSync(path.join(projectDir, "zenbu.plugin.json"), "utf8"))
      runtimeVersion = pluginManifest.runtime?.electron ?? null
    } catch {}
  }
  if (!runtimeVersion) {
    runtimeVersion = findInstalledVersion()
    if (!runtimeVersion) {
      console.error("zen build: no Electron runtime installed. Run: zen runtime install")
      process.exit(1)
    }
  }
  if (!runtimeVersion!.includes(".")) runtimeVersion += ".0.0"

  const repoUrl = getGitRemote(projectDir)
  const branch = getGitBranch(projectDir)
  const electronBin = getElectronBinary(runtimeVersion!)

  if (!fs.existsSync(electronBin)) {
    console.error(`zen build: Electron ${runtimeVersion} not installed. Run: zen runtime install ${runtimeVersion}`)
    process.exit(1)
  }

  const zenbuDir = path.join(projectDir, "zenbu")
  const versionsPath = fs.existsSync(path.join(zenbuDir, "setup", "versions.json"))
    ? path.join(zenbuDir, "setup", "versions.json")
    : path.join(projectDir, "zenbu", "packages", "init", "setup", "versions.json")

  let setupVersion = "1"
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "zenbu.plugin.json"), "utf8"))
    if (manifest.setup?.version) setupVersion = String(manifest.setup.version)
  } catch {}

  console.log(`\nBuilding ${name}.app...\n`)
  console.log(`  repo: ${repoUrl}`)
  console.log(`  branch: ${branch}`)
  console.log(`  runtime: Electron ${runtimeVersion}`)

  const stagingDir = path.join(os.tmpdir(), `zenbu-build-${crypto.randomBytes(4).toString("hex")}`)
  fs.mkdirSync(stagingDir, { recursive: true })

  console.log("\n  → downloading toolchain binaries...")
  const actualVersionsPath = fs.existsSync(versionsPath)
    ? versionsPath
    : path.resolve(projectDir, "zenbu", "setup", "versions.json")
  await downloadToolchain(stagingDir, actualVersionsPath)

  console.log("  → staging app files...")
  fs.writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify({
    name: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
    main: "setup-gate.mjs",
  }, null, 2) + "\n")

  const projectConfig = readConfig(projectDir)
  const updateUrl = projectConfig.publish?.provider === "github"
    ? `https://api.github.com/repos/${projectConfig.publish.owner}/${projectConfig.publish.repo}/releases/latest`
    : projectConfig.publish?.url ?? null

  fs.writeFileSync(path.join(stagingDir, "app-config.json"), JSON.stringify({
    repoUrl,
    name: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
    branch,
    electronVersion: runtimeVersion,
    setupVersion,
    updateUrl,
    version: projectConfig.app?.version ?? "0.0.1",
  }, null, 2) + "\n")

  const runtimePkgDir = path.join(zenbuDir, "packages", "runtime")
  fs.copyFileSync(path.join(runtimePkgDir, "setup-gate.mjs"), path.join(stagingDir, "setup-gate.mjs"))

  const setupSrcDir = path.join(runtimePkgDir, "setup")
  const setupDestDir = path.join(stagingDir, "setup")
  fs.mkdirSync(setupDestDir, { recursive: true })
  for (const file of fs.readdirSync(setupSrcDir)) {
    fs.copyFileSync(path.join(setupSrcDir, file), path.join(setupDestDir, file))
  }

  fs.mkdirSync(out, { recursive: true })
  const bundlePath = path.join(out, `${name}.app`)
  const electronApp = path.join(getRuntimeDir(runtimeVersion), "Electron.app")

  console.log("  → cloning Electron runtime...")
  if (fs.existsSync(bundlePath)) await exec("rm", ["-rf", bundlePath])
  await exec("cp", ["-c", "-R", electronApp, bundlePath])

  const contentsDir = path.join(bundlePath, "Contents")
  const macosDir = path.join(contentsDir, "MacOS")

  console.log("  → configuring app bundle...")
  fs.renameSync(path.join(macosDir, "Electron"), path.join(macosDir, name))

  const plist = path.join(contentsDir, "Info.plist")
  await exec("plutil", ["-replace", "CFBundleName", "-string", name, plist])
  await exec("plutil", ["-replace", "CFBundleDisplayName", "-string", name, plist])
  await exec("plutil", ["-replace", "CFBundleExecutable", "-string", name, plist])
  await exec("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, plist])

  const appCodeDir = path.join(contentsDir, "Resources", "app")
  if (fs.existsSync(appCodeDir)) await exec("rm", ["-rf", appCodeDir])
  fs.mkdirSync(appCodeDir, { recursive: true })

  console.log("  → copying staged files...")
  await exec("cp", ["-R", ...fs.readdirSync(stagingDir).map(f => path.join(stagingDir, f)), appCodeDir])

  const signIdentity = signingConfig?.identity ?? "-"
  console.log(`  → codesigning (${signIdentity === "-" ? "ad-hoc" : signIdentity})...`)
  await exec("codesign", ["--force", "--deep", "--sign", signIdentity, bundlePath])

  fs.rmSync(stagingDir, { recursive: true, force: true })

  console.log(`\n  ✓ Built ${bundlePath}\n`)
  console.log(`  Distribute this .app to users.`)
  console.log(`  On first launch, it will clone ${repoUrl} and set up automatically.\n`)
}
