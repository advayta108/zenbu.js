import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register as registerLoaderImpl, createRequire } from "node:module";

function registerLoader(specifier: string, opts?: { data?: unknown }) {
  // `node:module#register` typings don't include the `data` field in older
  // @types/node, so we cast at the boundary.
  return (registerLoaderImpl as unknown as (
    specifier: string,
    parentURL?: string | URL,
    options?: { data?: unknown },
  ) => unknown)(specifier, undefined, opts);
}
import { pathToFileURL } from "node:url";
import { register as registerTsx } from "tsx/esm/api";
import { bootstrapEnv } from "./env-bootstrap";

type PackageJson = {
  name?: string;
  zenbu?: {
    host?: string;
    branch?: string;
    updateUrl?: string;
  };
};

type ElectronEvent = { preventDefault(): void };
type ElectronApp = {
  getAppPath(): string;
  whenReady(): Promise<void>;
  on(event: "before-quit", listener: (event: ElectronEvent) => void): void;
  quit(): void;
  exit(code?: number): void;
};

type DynohotPauseModule = {
  closeAllWatchers?: () => void | Promise<void>;
};

type PluginModule = {
  default: () => unknown;
};

type PluginController = {
  main: () => Promise<void> | void;
};

const verbose = process.env.ZENBU_VERBOSE === "1";

function isPluginModule(value: unknown): value is PluginModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PluginModule).default === "function"
  );
}

function isPluginController(value: unknown): value is PluginController {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PluginController).main === "function"
  );
}

function envMs(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectArg(): string | null {
  const arg = process.argv.find((item) => item.startsWith("--project="));
  return arg ? path.resolve(arg.slice("--project=".length)) : null;
}

function appDirName(name: string): string {
  return name.replace(/^@/, "").replace(/[\\/]/g, "__");
}

function readPackageJson(packageDir: string): PackageJson {
  const pkgPath = path.join(packageDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
}

function findProjectRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(projectDir);
}

function resolveConfigPath(projectRoot: string): string {
  const candidates = [
    "zenbu.config.ts",
    "zenbu.config.mts",
    "zenbu.config.js",
    "zenbu.config.mjs",
  ];
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No zenbu config found at ${projectRoot}. Expected one of: ${candidates.join(", ")}`,
  );
}

function findTsconfig(projectRoot: string): string | false {
  const candidate = path.join(projectRoot, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : false;
}

function loadElectronApp(): ElectronApp {
  const requireFromCore = createRequire(import.meta.url);
  const electron = requireFromCore("electron") as { app?: ElectronApp };
  if (!electron.app) {
    throw new Error(
      "Electron app API is unavailable; setup-gate must run inside Electron",
    );
  }
  return electron.app;
}

async function closeRegisteredWatchers(): Promise<void> {
  const pause = (await import("@zenbujs/hmr/pause")) as DynohotPauseModule;
  await pause.closeAllWatchers?.();
}

type BootWindow = { windowId: string; win: unknown };

/**
 * Extract the splash's intended background color from a
 * `<meta name="zenbu-bg" content="#xxx">` tag. Used as the BaseWindow's
 * `backgroundColor` so the OS doesn't paint a single white frame before
 * the WebContentsView's pixels reach the screen. Convention only —
 * defaults to `#F4F4F4` when unset.
 */
function readSplashBgColor(splashPath: string): string {
  try {
    const html = fs.readFileSync(splashPath, "utf8");
    const match = html.match(
      /<meta\s+name=["']zenbu-bg["']\s+content=["']([^"']+)["']/i,
    );
    if (match?.[1]) return match[1];
  } catch {}
  return "#F4F4F4";
}

/**
 * Spawn the splash window before any plugin service evaluates. The window
 * is created HIDDEN, the splash HTML is loaded into a `WebContentsView`,
 * we wait for `loadFile` to resolve (= did-finish-load), then `win.show()`
 * — by the time the OS composites the window, the splash pixels are already
 * there. No white-frame flash.
 *
 * `BaseWindowService.evaluate()` adopts this window from
 * `globalThis.__zenbu_boot_windows__` instead of creating a new one, so
 * `WindowService.openView` can swap the splash content view for the
 * Vite-served renderer in-place when the renderer is ready.
 */
async function spawnSplashWindow(): Promise<void> {
  const slot = globalThis as unknown as {
    __zenbu_main_resolved_config__?: {
      payload?: { splashPath?: string };
    };
    __zenbu_boot_windows__?: BootWindow[];
  };
  const splashPath = slot.__zenbu_main_resolved_config__?.payload?.splashPath;
  if (!splashPath || !fs.existsSync(splashPath)) {
    if (verbose) {
      console.log("[setup-gate] no splash.html resolved; skipping splash window");
    }
    return;
  }

  const electron = (await import("electron")) as unknown as {
    BaseWindow: new (opts: Record<string, unknown>) => {
      contentView: { addChildView(view: unknown): void };
      getContentBounds(): { width: number; height: number };
      show(): void;
      on(event: string, cb: (...args: unknown[]) => void): void;
    };
    WebContentsView: new (opts?: Record<string, unknown>) => {
      webContents: {
        loadFile(path: string): Promise<void>;
      };
      setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    };
  };
  const backgroundColor = readSplashBgColor(splashPath);
  const win = new electron.BaseWindow({
    width: 1100,
    height: 750,
    show: false, // create hidden — we'll show after the splash has painted
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor,
  });
  const splashView = new electron.WebContentsView({
    // Render even while the parent window is hidden so by the time we
    // call show() the GPU has already composited the splash frame.
    webPreferences: { paintWhenInitiallyHidden: true },
  });
  win.contentView.addChildView(splashView);
  const bounds = win.getContentBounds();
  splashView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });

  // Wait for the splash to finish loading before showing, with a hard cap
  // so a broken splash doesn't strand the user with no window forever.
  await Promise.race([
    splashView.webContents.loadFile(splashPath).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
  win.show();

  const boot: BootWindow = { windowId: "main", win };
  slot.__zenbu_boot_windows__ = [...(slot.__zenbu_boot_windows__ ?? []), boot];

  if (verbose) {
    console.log("[setup-gate] splash window shown with", splashPath, "bg=", backgroundColor);
  }
}

async function registerLoaders(tsconfig: string | false, projectRoot: string): Promise<void> {
  // tsx must be registered BEFORE we resolve zenbu.config.ts (which is
  // typescript). We register tsx first, then load the config, then register
  // our zenbu loader. Node 22+ runs loader hooks in a worker thread, so the
  // resolved config is passed across the worker boundary via `register()`'s
  // `data` argument — a process-global stash on the main thread is not
  // visible to the loader.
  registerTsx({ tsconfig });

  const { loadConfig } = await import("./cli/lib/load-config");
  const { resolved, pluginSourceFiles } = await loadConfig(projectRoot);
  const loaderData = {
    payload: {
      plugins: resolved.plugins.map((p) => ({
        name: p.name,
        dir: p.dir,
        services: p.services,
        schemaPath: p.schemaPath,
        migrationsPath: p.migrationsPath,
        preloadPath: p.preloadPath,
        eventsPath: p.eventsPath,
        icons: p.icons,
      })),
      appEntrypoint: resolved.uiEntrypointPath,
      splashPath: resolved.splashPath,
    },
    pluginSourceFiles,
  };
  ;(globalThis as unknown as { __zenbu_main_resolved_config__?: typeof loaderData })
    .__zenbu_main_resolved_config__ = loaderData;

  registerLoader(import.meta.resolve("@zenbujs/core/loaders/zenbu"), {
    data: loaderData,
  });

  process.env.ZENBU_ADVICE_ROOT = projectRoot;
  await import("@zenbu/advice/node");

  const requireFromCore = createRequire(import.meta.url);
  const dynohotRegisterPath = requireFromCore.resolve("@zenbujs/hmr/register");
  const dynohot = await import(pathToFileURL(dynohotRegisterPath).href);
  if (typeof dynohot.register === "function") {
    // Ignore both `node_modules/` and any `dist/` directory. The latter
    // covers `@zenbujs/core` when it's `link:`'d for development — its
    // built `dist/*.mjs` chunks are framework code that the app shouldn't
    // be hot-reloading. Without this, an entry can be loaded twice (once
    // hot-wrapped via the user's plugin barrel, once non-hot via setup-gate's
    // own dynamic imports), producing two distinct hot module URLs and
    // double-evaluating services like `ServerService`.
    dynohot.register({ ignore: /[/\\](?:node_modules|dist)[/\\]/ });
  }
}

export async function setupGate(): Promise<void> {
  const app = loadElectronApp();
  await app.whenReady();
  bootstrapEnv();

  // Install shutdown handling before loaders can create native watchers.
  // Cmd+Q can arrive while setup is still importing hot-wrapped modules; if
  // Electron proceeds with its default teardown then parcel-watcher's native
  // cleanup can race a dying NAPI env.
  let shuttingDown = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const rt = (
        globalThis as {
          __zenbu_service_runtime__?: { shutdown(): Promise<void> };
        }
      ).__zenbu_service_runtime__;
      await rt?.shutdown();
    } catch (err) {
      console.error("[setup-gate] shutdown failed:", err);
    }
    try {
      await closeRegisteredWatchers();
    } catch (err) {
      console.error("[setup-gate] closeAllWatchers failed:", err);
    }
    // `process.exit` runs Node's normal shutdown, including the async
    // cleanup hooks parcel-watcher uses to drain native work. `app.exit`
    // bypasses too much of Node's cleanup path here.
    process.exit(exitCode);
  };
  app.on("before-quit", (event) => {
    event.preventDefault();
    void shutdown(0);
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const autoQuitReadyMs = envMs("ZENBU_AUTO_QUIT_AFTER_READY_MS");
  if (autoQuitReadyMs != null) {
    if (verbose) {
      console.log("[setup-gate] auto-quit after ready scheduled:", autoQuitReadyMs);
    }
    setTimeout(() => app.quit(), autoQuitReadyMs).unref();
  }

  const bundledAppPath = app.getAppPath();
  const bundledPkg = readPackageJson(bundledAppPath);
  const appName = bundledPkg.name ?? path.basename(bundledAppPath);
  const resolvedProjectDir =
    projectArg() ??
    path.join(
      process.env.ZENBU_APPS_DIR ?? path.join(os.homedir(), ".zenbu", "apps"),
      appDirName(appName),
    );

  if (!fs.existsSync(resolvedProjectDir)) {
    throw new Error(
      `setup-gate: project directory ${resolvedProjectDir} does not exist. ` +
        `In a shipped .app, the launcher provisions this dir before invoking setup-gate. ` +
        `In dev, point at an existing project with --project=.`,
    );
  }

  const projectRoot = findProjectRoot(resolvedProjectDir);
  const configPath = resolveConfigPath(projectRoot);
  const tsconfig = findTsconfig(projectRoot);

  process.chdir(projectRoot);
  process.env.ZENBU_CONFIG_PATH = configPath;

  if (!process.argv.some((arg) => arg.startsWith("--project="))) {
    process.argv.push(`--project=${resolvedProjectDir}`);
  }

  if (verbose) {
    console.log("[setup-gate] project:", resolvedProjectDir);
    console.log("[setup-gate] config:", configPath);
  }

  await registerLoaders(tsconfig, projectRoot);
  if (shuttingDown) return;

  // Pop a splash window NOW (we have an entrypoint resolved). Plugin
  // services + Vite take 1-2s to boot; without this the dock icon
  // bounces with no window. BaseWindowService adopts the splash window
  // on first evaluate and hands it off to WindowService.openView, which
  // swaps the splash WebContentsView for the Vite-served renderer.
  try {
    await spawnSplashWindow();
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;

  try {
    const { defaultServices } = await import("./services/default");
    await defaultServices();
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;

  const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
  let mod: unknown;
  try {
    mod = await import(url, { with: { hot: "import" } });
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  if (isPluginModule(mod)) {
    const controller = mod.default();
    if (isPluginController(controller)) {
      await controller.main();
    }
  }
  if (shuttingDown) return;

  const runtime = (
    globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } }
  ).__zenbu_service_runtime__;
  await runtime?.whenIdle();

  const autoQuitMs = envMs("ZENBU_AUTO_QUIT_AFTER_IDLE_MS");
  if (autoQuitMs != null) {
    if (verbose) console.log("[setup-gate] auto-quit scheduled:", autoQuitMs);
    setTimeout(() => app.quit(), autoQuitMs).unref();
  }
}

void setupGate().catch((error) => {
  console.error(error);
  process.exit(1);
});
