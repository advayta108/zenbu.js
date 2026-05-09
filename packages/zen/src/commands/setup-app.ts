import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { findInstalledVersion, getElectronBinary, getRuntimeDir } from "./runtime"

const APPLICATIONS_DIR = "/Applications"

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) return cwd
  console.error("zen setup-app: no zenbu.plugin.json found in current directory")
  process.exit(1)
}

function parseArgs(argv: string[]): { name: string; runtimeVersion: string } {
  let name: string | null = null
  let runtimeVersion: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--name" || arg === "-n") {
      name = argv[++i] ?? null
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length)
    } else if (arg === "--runtime" || arg === "-r") {
      runtimeVersion = argv[++i] ?? null
    } else if (arg.startsWith("--runtime=")) {
      runtimeVersion = arg.slice("--runtime=".length)
    }
  }

  if (!runtimeVersion) {
    runtimeVersion = findInstalledVersion()
    if (!runtimeVersion) {
      console.error("zen setup-app: no Electron runtime installed. Run: zen runtime install")
      process.exit(1)
    }
  }
  if (!runtimeVersion.includes(".")) runtimeVersion += ".0.0"

  if (!name) {
    const projectDir = resolveProjectDir()
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
      ) as { name?: string }
      name = pkg.name ?? path.basename(projectDir)
    } catch {
      name = path.basename(projectDir)
    }
  }

  return { name: name!, runtimeVersion }
}

export async function runSetupApp(argv: string[]) {
  const projectDir = resolveProjectDir()
  const { name, runtimeVersion } = parseArgs(argv)
  const electronBin = getElectronBinary(runtimeVersion)

  if (!fs.existsSync(electronBin)) {
    console.error(`zen setup-app: Electron ${runtimeVersion} not installed. Run: zen runtime install ${runtimeVersion}`)
    process.exit(1)
  }

  const bundlePath = path.join(APPLICATIONS_DIR, `${name}.app`)
  const electronApp = path.join(getRuntimeDir(runtimeVersion), "Electron.app")

  console.log(`\nCreating ${name}.app...\n`)

  if (fs.existsSync(bundlePath)) {
    console.log("  → removing existing app bundle...")
    await exec("rm", ["-rf", bundlePath])
  }

  console.log("  → cloning Electron.app...")
  await exec("cp", ["-c", "-R", electronApp, bundlePath])

  const contentsDir = path.join(bundlePath, "Contents")
  const macosDir = path.join(contentsDir, "MacOS")
  const resourcesDir = path.join(contentsDir, "Resources")

  console.log("  → renaming binary...")
  fs.renameSync(path.join(macosDir, "Electron"), path.join(macosDir, name))

  console.log("  → updating Info.plist...")
  const plist = path.join(contentsDir, "Info.plist")
  await exec("plutil", ["-replace", "CFBundleName", "-string", name, plist])
  await exec("plutil", ["-replace", "CFBundleDisplayName", "-string", name, plist])
  await exec("plutil", ["-replace", "CFBundleExecutable", "-string", name, plist])
  const bundleId = `dev.zenbu.${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
  await exec("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, plist])

  console.log("  → writing entry point...")
  const appCodeDir = path.join(resourcesDir, "app")
  fs.mkdirSync(appCodeDir, { recursive: true })

  const bootMjsPath = path.join(projectDir, "zenbu", "packages", "runtime", "boot.mjs")
  fs.writeFileSync(
    path.join(appCodeDir, "package.json"),
    JSON.stringify({ name: bundleId, main: "main.mjs" }) + "\n",
  )
  fs.writeFileSync(
    path.join(appCodeDir, "main.mjs"),
    `await import(${JSON.stringify(bootMjsPath)});\n`,
  )

  console.log("  → codesigning...")
  await exec("codesign", ["--force", "--deep", "--sign", "-", bundlePath])

  console.log(`\n  ✓ Created ${bundlePath}\n`)
  console.log(`  Launch with: open "${bundlePath}"`)
  console.log(`  Or run: zen open\n`)
}
