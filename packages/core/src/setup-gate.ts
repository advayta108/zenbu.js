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
  exit(code?: number): void;
};

type DynohotPauseModule = {
  closeAllWatchers?: () => void | Promise<void>;
};

const verbose = process.env.ZENBU_VERBOSE === "1";

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
  const { defaultServices } = await import("./services/default");
  await defaultServices();

  // Drain services and native watchers before Electron starts tearing down
  // Node. This covers Cmd+Q and terminal Ctrl+C, which does not fire
  // `before-quit`.
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
    app.exit(exitCode);
  };
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown(0);
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
  const mod = await import(url, { with: { hot: "import" } });
  if (typeof mod.default === "function") {
    const controller = mod.default();
    if (controller && typeof controller.main === "function") {
      await controller.main();
    }
  }

  const runtime = (
    globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } }
  ).__zenbu_service_runtime__;
  await runtime?.whenIdle();
}

void setupGate().catch((error) => {
  console.error(error);
  process.exit(1);
});
