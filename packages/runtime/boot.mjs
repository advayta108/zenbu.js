import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { register as registerLoader } from "node:module"
import { app } from "electron"
import { bootstrapEnv } from "./env-bootstrap.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

function findProjectRoot(manifestPath) {
  let dir = path.dirname(path.resolve(manifestPath))
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    dir = path.dirname(dir)
  }
  return path.dirname(path.resolve(manifestPath))
}

function findTsconfig(manifestPath) {
  let dir = path.dirname(manifestPath)
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "tsconfig.json")
    if (fs.existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  return false
}

function resolveProjectDir() {
  const projectArg = process.argv.find(a => a.startsWith("--project="))
  if (projectArg) return projectArg.slice("--project=".length)

  const bootDir = __dirname
  const zenbuDir = path.resolve(bootDir, "..", "..")
  const parentDir = path.resolve(zenbuDir, "..")
  if (fs.existsSync(path.join(parentDir, "zenbu.plugin.json"))) return parentDir

  return process.cwd()
}

function resolveManifest(projectDir) {
  const manifest = path.join(projectDir, "zenbu.plugin.json")
  if (fs.existsSync(manifest)) return manifest
  console.error(`[runtime] zenbu.plugin.json not found in ${projectDir}`)
  process.exit(1)
}

function writeInlineConfig(plugins) {
  const tmpDir = path.join(os.tmpdir(), "zenbu-runtime")
  fs.mkdirSync(tmpDir, { recursive: true })
  const configPath = path.join(tmpDir, "config.json")
  fs.writeFileSync(configPath, JSON.stringify({ plugins }, null, 2))
  return configPath
}

app.whenReady().then(async () => {
  try {
    console.log("[runtime] booting...")

    bootstrapEnv()

    const projectDir = resolveProjectDir()
    const manifestPath = resolveManifest(projectDir)
    const projectRoot = findProjectRoot(manifestPath)
    const tsconfig = findTsconfig(manifestPath)

    const zenbuDir = path.resolve(projectDir, "zenbu")
    const packagesDir = path.join(zenbuDir, "packages")

    process.env.ZENBU_PACKAGES_DIR = packagesDir

    const zenbuNodeModules = path.join(zenbuDir, "node_modules")
    const existing = process.env.NODE_PATH ?? ""
    process.env.NODE_PATH = existing
      ? `${zenbuNodeModules}${path.delimiter}${existing}`
      : zenbuNodeModules

    console.log("[runtime] project:", projectDir)
    console.log("[runtime] manifest:", manifestPath)
    console.log("[runtime] packages:", packagesDir)

    const zenbuLoaderPath = pathToFileURL(
      path.join(__dirname, "zenbu-loader-hooks.js")
    ).href
    registerLoader(zenbuLoaderPath)

    const aliasLoaderPath = pathToFileURL(
      path.join(__dirname, "alias-loader-hooks.js")
    ).href
    registerLoader(aliasLoaderPath)

    const { register: registerTsx } = await import("tsx/esm/api")
    registerTsx({ tsconfig })

    process.env.ZENBU_ADVICE_ROOT = projectRoot
    await import("@zenbu/advice/node")

    const { register: registerDynohot } = await import("dynohot/register")
    registerDynohot({ ignore: /[/\\]node_modules[/\\]/ })

    process.chdir(projectRoot)
    console.log("[runtime] cwd:", process.cwd())

    const configPath = writeInlineConfig([manifestPath])

    const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`
    console.log("[runtime] loading plugins from:", configPath)

    const mod = await import(url, { with: { hot: "import" } })
    if (typeof mod.default === "function") {
      const controller = mod.default()
      if (controller && typeof controller.main === "function") {
        await controller.main()
      }
    }

    const runtime = globalThis.__zenbu_service_runtime__
    if (runtime) {
      console.log("[runtime] draining services...")
      await runtime.whenIdle()
    }

    console.log("[runtime] boot complete")
  } catch (error) {
    console.error("[runtime] failed to start:", error)
    app.exit(1)
  }
})
