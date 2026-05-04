import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { register as registerLoader } from "node:module"
import { app, BaseWindow, WebContentsView } from "electron"
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

    const { createRequire } = await import("node:module")
    const runtimeRequire = createRequire(path.join(__dirname, "package.json"))

    const tsxPath = runtimeRequire.resolve("tsx/esm/api")
    const { register: registerTsx } = await import(pathToFileURL(tsxPath).href)
    registerTsx({ tsconfig })

    process.env.ZENBU_ADVICE_ROOT = projectRoot
    const advicePkgDir = path.join(packagesDir, "advice")
    const advicePath = path.join(advicePkgDir, "src", "node.ts")
    await import(pathToFileURL(advicePath).href)

    const dynohotRegPath = path.join(packagesDir, "dynohot", "dist", "loader", "register.js")
    const { register: registerDynohot } = await import(pathToFileURL(dynohotRegPath).href)
    registerDynohot({ ignore: /[/\\]node_modules[/\\]/ })

    const bootWindow = new BaseWindow({
      width: 900,
      height: 700,
      show: true,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#F4F4F4",
    })
    const loadingView = new WebContentsView({
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    })
    loadingView.setBackgroundColor("#F4F4F4")
    bootWindow.contentView.addChildView(loadingView)
    const layoutView = () => {
      const { width, height } = bootWindow.getContentBounds()
      loadingView.setBounds({ x: 0, y: 0, width, height })
    }
    layoutView()
    bootWindow.on("resize", layoutView)
    bootWindow.__zenbu_loading_view__ = loadingView

    globalThis.__zenbu_boot_windows__ = [
      { windowId: "main", win: bootWindow },
    ]

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
