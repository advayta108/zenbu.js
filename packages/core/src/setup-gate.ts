/**
 * this file is in a really hacky state needs to be fixed
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register as registerLoaderImpl, createRequire } from "node:module";

function registerLoader(specifier: string, opts?: { data?: unknown }) {
  // `node:module#register` typings don't include the `data` field in older
  // @types/node, so we cast at the boundary.
  return (
    registerLoaderImpl as unknown as (
      specifier: string,
      parentURL?: string | URL,
      options?: { data?: unknown },
    ) => unknown
  )(specifier, undefined, opts);
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
  on(
    event: "before-quit" | "window-all-closed",
    listener: (event: ElectronEvent) => void,
  ): void;
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

/**
 * Suppress `@babel/generator`'s "[BABEL] Note: The code generator has
 * deoptimised the styling of <file> as it exceeds the max of 500KB" notice.
 * It's hardcoded as `console.error` in @babel/generator's printer with no
 * opt-out (https://github.com/babel/babel/issues/7569). Vite's
 * `@vitejs/plugin-react` runs Babel for fast-refresh on prebundled deps
 * caches, hitting this for `react-dom_client.js` and similar large chunks
 * on every dev boot. We filter the one specific message at the
 * `console.error` boundary so the rest of console.error stays useful.
 *
 * Patched once at module init, before any Vite dev server has started.
 */
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (
    args.length > 0 &&
    typeof args[0] === "string" &&
    args[0].startsWith("[BABEL] Note: The code generator has deoptimised")
  ) {
    return;
  }
  _origConsoleError(...args);
};

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
    `No zenbu config found at ${projectRoot}. Expected one of: ${candidates.join(
      ", ",
    )}`,
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

type ElectronWindowing = {
  BaseWindow: new (opts: Record<string, unknown>) => {
    contentView: {
      addChildView(view: unknown): void;
      removeChildView(view: unknown): void;
      readonly children: unknown[];
    };
    getContentBounds(): { width: number; height: number };
    show(): void;
    setBackgroundColor(color: string): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
  WebContentsView: new (opts?: Record<string, unknown>) => {
    webContents: {
      loadFile(path: string): Promise<void>;
      close(): void;
    };
    setBounds(bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): void;
  };
};

/**
 * Spawn the splash window as early as possible OR adopt the launcher's
 * pre-existing installing window. The window is created with `show: true`
 * and its `backgroundColor` set up front so the OS composites a colored
 * frame on the next vsync — no waiting for `did-finish-load` before any
 * pixels reach the screen. Splash content paints into the WebContentsView
 * a frame or two later, replacing the flat color.
 *
 * If the launcher already opened an installing window
 * (`globalThis.__zenbu_boot_windows__` is non-empty), we reuse that
 * BaseWindow and just swap its child WebContentsView from installing.html
 * to splash.html. The titlebar / window chrome stays continuous.
 *
 * `BaseWindowService.evaluate()` adopts the resulting window from
 * `globalThis.__zenbu_boot_windows__` instead of creating a new one, so
 * `WindowService.openView` can swap the splash content view for the
 * Vite-served renderer in-place when the renderer is ready.
 */
async function spawnSplashWindow(
  splashPath: string | undefined,
): Promise<void> {
  if (!splashPath || !fs.existsSync(splashPath)) {
    if (verbose) {
      console.log(
        "[setup-gate] no splash.html resolved; skipping splash window",
      );
    }
    return;
  }

  const slot = globalThis as unknown as {
    __zenbu_boot_windows__?: BootWindow[];
  };
  const electron = (await import("electron")) as unknown as ElectronWindowing;
  const backgroundColor = readSplashBgColor(splashPath);
  // Only adopt the launcher's "main" window. Anything else in the slot
  // (legacy code, plugins) is ignored — we'd rather have a momentary
  // second window than swap content on a window we don't own.
  const existing = slot.__zenbu_boot_windows__?.find(
    (b) => b.windowId === "main",
  );

  type WindowingWindow = InstanceType<ElectronWindowing["BaseWindow"]>;
  let win: WindowingWindow;
  if (existing) {
    win = existing.win as WindowingWindow;
    // Update the BaseWindow's bg color to splash's so the brief gap
    // between removing the installing view and the splash WebContentsView
    // painting shows splash's intended color, not installing's.
    try {
      win.setBackgroundColor(backgroundColor);
    } catch {}
    // Tear down the installing window's child view(s); we'll re-fill with
    // the splash view below.
    for (const child of [...win.contentView.children]) {
      try {
        win.contentView.removeChildView(child);
      } catch {}
      const wc = (child as { webContents?: { close(): void } }).webContents;
      try {
        wc?.close();
      } catch {}
    }
    if (verbose) {
      console.log(
        "[setup-gate] adopting existing installing window for splash",
      );
    }
  } else {
    win = new electron.BaseWindow({
      width: 1100,
      height: 750,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 10 },
      backgroundColor,
    });
  }

  const splashView = new electron.WebContentsView();
  win.contentView.addChildView(splashView);
  const bounds = win.getContentBounds();
  splashView.setBounds({
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
  });

  /**
   * human note: this is a bad solution we should have an invariant verifying program state
   * but its fine for now
   */
  // We cap at 1500ms so a broken splash (404, JS error, etc.) doesn't
  // strand boot — the BaseWindow's backgroundColor already makes a
  // visible frame appear in that case.
  await Promise.race([
    splashView.webContents.loadFile(splashPath).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);

  if (!existing) {
    const boot: BootWindow = { windowId: "main", win };
    slot.__zenbu_boot_windows__ = [
      ...(slot.__zenbu_boot_windows__ ?? []),
      boot,
    ];
  }

  if (verbose) {
    console.log(
      "[setup-gate] splash window shown with",
      splashPath,
      "bg=",
      backgroundColor,
    );
  }
}

type LoaderData = {
  payload: {
    plugins: Array<{
      name: string;
      dir: string;
      services: string[];
      schemaPath?: string;
      migrationsPath?: string;
      preloadPath?: string;
      eventsPath?: string;
      icons?: Record<string, string>;
    }>;
    appEntrypoint: string;
    splashPath: string;
    installingPath?: string;
  };
  pluginSourceFiles: string[];
};

/**
 * Phase 1 of loader setup: register tsx + read the user's `zenbu.config.ts`.
 * This is split out from the rest of the loader registration so the splash
 * window can be spawned the moment `splashPath` is known, instead of
 * waiting for advice + dynohot to register too. tsx must run with the
 * project's tsconfig because user code (config + plugins) may rely on
 * non-default TS settings (paths, jsx, etc.).
 */
async function loadConfigPhase(
  tsconfig: string | false,
  projectRoot: string,
): Promise<LoaderData> {
  registerTsx({ tsconfig });

  const { loadConfig } = await import("./cli/lib/load-config");
  const { resolved, pluginSourceFiles } = await loadConfig(projectRoot);
  const loaderData: LoaderData = {
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
      installingPath: resolved.installingPath,
    },
    pluginSourceFiles,
  };
  (
    globalThis as unknown as { __zenbu_main_resolved_config__?: LoaderData }
  ).__zenbu_main_resolved_config__ = loaderData;
  return loaderData;
}

/**
 * Phase 2 of loader setup: register the zenbu loader, advice, and dynohot.
 * Runs AFTER the splash window is on screen so the user sees pixels while
 * advice patches install and dynohot's worker spawns. Node 22+ runs loader
 * hooks in a worker thread; the resolved config crosses the boundary via
 * `register()`'s `data` argument.
 */
async function registerLoadersPhase(
  projectRoot: string,
  loaderData: LoaderData,
): Promise<void> {
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
  // Always-on minimal startup logging. One line per major completed step
  // with elapsed-since-start, so a scrollback shows where boot time goes
  // without needing ZENBU_VERBOSE=1.
  const t0 = Date.now();
  const ms = (): string => `+${Date.now() - t0}ms`;
  const step = (label: string): void => {
    console.log(`[zenbu] ${label} (${ms()})`);
  };

  const app = loadElectronApp();
  await app.whenReady();
  step("electron ready");
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
  /**
   * i think we probably want to expose this in an editable form to the user
   */
  app.on("window-all-closed", () => {});
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const autoQuitReadyMs = envMs("ZENBU_AUTO_QUIT_AFTER_READY_MS");
  if (autoQuitReadyMs != null) {
    if (verbose) {
      console.log(
        "[setup-gate] auto-quit after ready scheduled:",
        autoQuitReadyMs,
      );
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

  // Pop the splash as early as possible. Only `loadConfig` is needed to
  // know `splashPath`; advice + dynohot registration is deferred until
  // after the window is on screen so the user sees pixels while those
  // run. BaseWindowService adopts the splash window on first evaluate
  // and hands it off to WindowService.openView, which swaps the splash
  // WebContentsView for the Vite-served renderer.
  let loaderData: LoaderData;
  try {
    loaderData = await loadConfigPhase(tsconfig, projectRoot);
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step(`config loaded (${loaderData.payload.plugins.length} plugins)`);

  try {
    // spawnSplashWindow now awaits the splash's did-finish-load (with a
    // 1500ms cap), so by the time it returns the splash content is
    // loaded into the renderer process AND the main thread has yielded
    // long enough for AppKit to composite the window. No artificial
    // setImmediate / setTimeout yield needed.
    await spawnSplashWindow(loaderData.payload.splashPath);
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step("splash shown");

  try {
    await registerLoadersPhase(projectRoot, loaderData);
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step("loaders registered");

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
  step("plugins evaluated");

  const runtime = (
    globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } }
  ).__zenbu_service_runtime__;
  await runtime?.whenIdle();
  step("ready");

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
