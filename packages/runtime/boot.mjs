process.on("uncaughtException", (err) => { if (err.code === "EPIPE") return; console.error?.("[boot] uncaught:", err); });
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register as registerLoader } from "node:module";
import { app, BaseWindow, WebContentsView, ipcMain, session } from "electron";
import { bootstrapEnv } from "./env-bootstrap.mjs";
import { updater } from "./updater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


function findProjectRoot(manifestPath) {
  let dir = path.dirname(path.resolve(manifestPath));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(manifestPath));
}

function findTsconfig(manifestPath) {
  let dir = path.dirname(manifestPath);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return false;
}

function resolveProjectDir() {
  const projectArg = process.argv.find((a) => a.startsWith("--project="));
  if (projectArg) return projectArg.slice("--project=".length);

  const bootDir = __dirname;
  const zenbuDir = path.resolve(bootDir, "..", "..");
  const parentDir = path.resolve(zenbuDir, "..");
  if (fs.existsSync(path.join(parentDir, "zenbu.plugin.json")))
    return parentDir;

  return process.cwd();
}

function resolveManifest(projectDir) {
  const manifest = path.join(projectDir, "zenbu.plugin.json");
  if (fs.existsSync(manifest)) return manifest;
    console.error(`[boot] zenbu.plugin.json not found in ${projectDir}`);
  process.exit(1);
}

function resolveProjectConfig(projectDir) {
  const configPath = path.join(projectDir, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`[boot] config.json not found in ${projectDir}`);
    process.exit(1);
  }
  return configPath;
}

ipcMain.handle("zenbu:updater:check", async () => {
  return updater.check();
});

ipcMain.handle("zenbu:updater:download-and-install", async (event) => {
  const dl = updater.download();
  dl.on("progress", (p) => {
    event.sender.send("zenbu:updater:progress", p);
  });
  await dl.finished;
  await updater.install();
});

app.whenReady().then(async () => {
  try {
    const verbose = process.env.ZENBU_VERBOSE === "1";
    console.log("[boot] starting...");

    bootstrapEnv();

    const projectDir = resolveProjectDir();
    const manifestPath = resolveManifest(projectDir);
    const projectRoot = findProjectRoot(manifestPath);
    const tsconfig = findTsconfig(manifestPath);

    const zenbuDir = path.resolve(projectDir, "zenbu");
    const packagesDir = path.join(zenbuDir, "packages");

    process.env.ZENBU_PACKAGES_DIR = packagesDir;

    const zenbuNodeModules = path.join(zenbuDir, "node_modules");
    const existing = process.env.NODE_PATH ?? "";
    process.env.NODE_PATH = existing
      ? `${zenbuNodeModules}${path.delimiter}${existing}`
      : zenbuNodeModules;

    if (verbose) {
      console.log("[boot] project:", projectDir);
      console.log("[boot] manifest:", manifestPath);
      console.log("[boot] packages:", packagesDir);
    }

    const zenbuLoaderPath = pathToFileURL(
      path.join(__dirname, "zenbu-loader-hooks.js"),
    ).href;
    registerLoader(zenbuLoaderPath);

    const aliasLoaderPath = pathToFileURL(
      path.join(__dirname, "alias-loader-hooks.js"),
    ).href;
    registerLoader(aliasLoaderPath);

    const { createRequire } = await import("node:module");
    const runtimeRequire = createRequire(path.join(__dirname, "package.json"));

    const tsxPath = runtimeRequire.resolve("tsx/esm/api");
    const { register: registerTsx } = await import(pathToFileURL(tsxPath).href);
    registerTsx({ tsconfig });

    process.env.ZENBU_ADVICE_ROOT = projectRoot;
    const advicePkgDir = path.join(packagesDir, "advice");
    const advicePath = path.join(advicePkgDir, "src", "node.ts");
    await import(pathToFileURL(advicePath).href);

    const dynohotRegPath = path.join(
      packagesDir,
      "dynohot",
      "dist",
      "loader",
      "register.js",
    );
    const { register: registerDynohot } = await import(
      pathToFileURL(dynohotRegPath).href
    );
    registerDynohot({ ignore: /[/\\]node_modules[/\\]/ });

    const loadingHtmlPath = path.join(projectDir, "loading.html");
    const hasLoadingPage = fs.existsSync(loadingHtmlPath);

    const bootWindow = new BaseWindow({
      width: 900,
      height: 700,
      show: hasLoadingPage,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#000000",
    });

    if (hasLoadingPage) {
      const loadingView = new WebContentsView({
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      loadingView.setBackgroundColor("#000000");
      bootWindow.contentView.addChildView(loadingView);
      const layoutView = () => {
        const { width, height } = bootWindow.getContentBounds();
        loadingView.setBounds({ x: 0, y: 0, width, height });
      };
      layoutView();
      bootWindow.on("resize", layoutView);
      loadingView.webContents.loadFile(loadingHtmlPath);
      bootWindow.__zenbu_loading_view__ = loadingView;
    }

    globalThis.__zenbu_boot_windows__ = [{ windowId: "main", win: bootWindow }];

    const appSlug = path.basename(projectDir);
    const rendererPartition = `persist:renderer-${appSlug}`;
    globalThis.__zenbu_renderer_partition__ = rendererPartition;

    // Clear ServiceWorker storage for the renderer partition to prevent
    // corrupt SW databases from blocking navigation (~1s stall).
    session.fromPartition(rendererPartition).clearStorageData({
      storages: ["serviceworkers"],
    }).catch(() => {});

    process.chdir(projectRoot);
    if (verbose) console.log("[boot] cwd:", process.cwd());

    if (!process.argv.some((a) => a.startsWith("--zen-cwd="))) {
      process.argv.push(`--zen-cwd=${projectDir}`);
    }

    const configPath = resolveProjectConfig(projectDir);
    process.env.ZENBU_CONFIG_PATH = configPath;

    const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
    if (verbose) console.log("[boot] loading plugins from:", configPath);

    const mod = await import(url, { with: { hot: "import" } });
    if (typeof mod.default === "function") {
      const controller = mod.default();
      if (controller && typeof controller.main === "function") {
        await controller.main();
      }
    }

    const runtime = globalThis.__zenbu_service_runtime__;
    if (runtime) {
      if (verbose) console.log("[boot] draining services...");
      await runtime.whenIdle();
    } else {
      console.warn("[boot] no service runtime found");
    }

    console.log("[boot] ready");

    let shutdownState = "idle";
    app.on("before-quit", (e) => {
      if (shutdownState === "ready") return;
      e.preventDefault();
      if (shutdownState === "running") return;
      shutdownState = "running";

      console.log("[boot] shutting down...");

      const hardKillTimer = setTimeout(() => {
        console.warn("[boot] shutdown timed out — forcing SIGKILL");
        process.kill(process.pid, "SIGKILL");
      }, 2000);

      const finalize = async () => {
        try {
          const dynohotPausePath = pathToFileURL(
            path.join(
              process.env.ZENBU_PACKAGES_DIR,
              "dynohot",
              "dist",
              "runtime",
              "pause.js",
            ),
          ).href;
          const { closeAllWatchers } = await import(dynohotPausePath);
          await closeAllWatchers();
        } catch (err) {
          console.error("[boot] closeAllWatchers failed:", err);
        }
        process.kill(process.pid, "SIGKILL");
      };

      const r = globalThis.__zenbu_service_runtime__;
      if (r) {
        r.shutdown()
          .then(() => {
            clearTimeout(hardKillTimer);
            return finalize();
          })
          .catch((err) => {
            console.error("[boot] shutdown failed:", err);
            clearTimeout(hardKillTimer);
            finalize();
          });
      } else {
        clearTimeout(hardKillTimer);
        finalize();
      }
    });
  } catch (error) {
    console.error("[boot] failed to start:", error);
    app.exit(1);
  }
});
