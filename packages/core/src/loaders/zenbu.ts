import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

type LoaderContext = {
  hot?: {
    watch?: (url: URL) => void;
    invalidate?: () => void;
  };
};

type LoaderResult = {
  format: "module";
  source: string;
  shortCircuit: true;
};

type NextResolve = (specifier: string, context: LoaderContext) => unknown;

type NextLoad = (url: string, context: LoaderContext) => unknown;

type TracePort = {
  on: (event: "message", handler: (message: unknown) => void) => void;
  postMessage: (message: unknown) => void;
  unref?: () => void;
};

type InitializeData = {
  tracePort?: TracePort;
  payload?: RegistryPayload;
  pluginSourceFiles?: string[];
};

const verbose = process.env.ZENBU_VERBOSE === "1";

const loaderName = "zenbu-loader";
let tracePort: TracePort | null = null;
const stats = {
  resolveCount: 0,
  resolveMs: 0,
  loadCount: 0,
  loadMs: 0,
};

let resolvedPayload: RegistryPayload | null = null;
let resolvedPluginSourceFiles: string[] = [];
/**
 * Number of times we've materialized the plugin root since boot. 
 */
let pluginsRootInvocations = 0;

export function initialize(data?: InitializeData): void {
  if (data?.payload) {
    resolvedPayload = data.payload;
    resolvedPluginSourceFiles = data.pluginSourceFiles ?? [];
  }
  if (data?.tracePort) {
    tracePort = data.tracePort;
    tracePort.on("message", (msg) => {
      if (msg !== "flush") return;
      try {
        tracePort?.postMessage({ name: loaderName, ...stats });
      } catch {}
      stats.resolveCount = 0;
      stats.resolveMs = 0;
      stats.loadCount = 0;
      stats.loadMs = 0;
    });
    tracePort.unref?.();
  }
}

// =============================================================================
//                              shared utilities
// =============================================================================

function globRegex(filePattern: string): RegExp {
  return new RegExp(
    `^${filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
  );
}

function expandGlob(pattern: string): string[] {
  const dir = path.dirname(pattern);
  const regex = globRegex(path.basename(pattern));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => regex.test(file))
    .map((file) => path.resolve(dir, file));
}

function buildSource(imports: string[]): string {
  return imports
    .map((specifier) => `import ${JSON.stringify(specifier)}\n`)
    .join("");
}

// =============================================================================
//                         config-driven barrel generation
// =============================================================================

interface ResolvedPluginRecord {
  name: string;
  dir: string;
  services: string[];
  schemaPath?: string;
  migrationsPath?: string;
  preloadPath?: string;
  eventsPath?: string;
  icons?: Record<string, string>;
}

interface RegistryPayload {
  plugins: ResolvedPluginRecord[];
  appEntrypoint: string;
  splashPath: string;
}

/**
 * Read the resolved config from the process global. setup-gate populates
 * this before registering our loader, so by the time `load()` is invoked
 * the snapshot is always present.
 *
 * We can't `await import("zenbu.config.ts")` from inside `load()` because
 * Node's ESM loader serializes load hooks — a dynamic import re-enters the
 * loader chain and deadlocks. Pre-resolving in setup-gate sidesteps that.
 */
function resolveConfigViaSubprocess(projectDir: string): {
  payload: RegistryPayload;
  pluginSourceFiles: string[];
} {
  // Locate the bundled resolver script. It sits next to this file in
  // `dist/cli/resolve-config.mjs` (peer of `dist/loaders/zenbu.mjs`).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "cli", "resolve-config.mjs"),
    path.resolve(here, "..", "..", "dist", "cli", "resolve-config.mjs"),
  ];
  const resolverScript = candidates.find((c) => fs.existsSync(c));
  if (!resolverScript) {
    throw new Error(
      `[zenbu-loader] resolve-config.mjs not found (looked in: ${candidates.join(
        ", ",
      )})`,
    );
  }
  /**
   * this takes ~100ms and can be heavily optimized, but its a fine solution for now
   */
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const out = execFileSync(process.execPath, [resolverScript, projectDir], {
    encoding: "utf8",
    timeout: 1000,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out) as {
    payload: RegistryPayload;
    pluginSourceFiles: string[];
  };
}

function getResolvedConfig(configPath: string): {
  payload: RegistryPayload;
  pluginSourceFiles: string[];
} {
  // First call: use the payload sent through `register()`'s `data` channel
  // by setup-gate. Cheap, no subprocess.
  if (pluginsRootInvocations === 0) {
    pluginsRootInvocations += 1;
    if (!resolvedPayload) {
      throw new Error(
        "[zenbu-loader] zenbu config not resolved before loader registration. " +
          "setup-gate must pass it via register(specifier, { data: { payload, pluginSourceFiles } }).",
      );
    }
    return {
      payload: resolvedPayload,
      pluginSourceFiles: resolvedPluginSourceFiles,
    };
  }
  // Subsequent calls (dynohot invalidation): re-evaluate the user's
  // zenbu.config.ts from disk by shelling out to `resolve-config.mjs`. This
  // is what makes adding/removing plugins or changing service globs in
  // zenbu.config.ts hot-reload — without re-reading the file, the loader
  // would just keep emitting the same stale barrel forever.
  pluginsRootInvocations += 1;
  const projectDir = path.dirname(configPath);
  const fresh = resolveConfigViaSubprocess(projectDir);
  resolvedPayload = fresh.payload;
  resolvedPluginSourceFiles = fresh.pluginSourceFiles;
  return fresh;
}

/**
 * Generate the top-level plugins barrel. The first import is the registry
 * setup module; ESM evaluates left-to-right in import order, so by the time
 * the plugin barrels start importing service files, `replacePlugins(...)` and
 * `registerAppEntrypoint(...)` have already populated the runtime registry.
 */
function buildPluginsRoot(payload: RegistryPayload): {
  source: string;
  barrelUrls: string[];
} {
  const registryUrl = `zenbu:registry?data=${encodeURIComponent(
    JSON.stringify(payload),
  )}`;
  const barrelUrls = payload.plugins.map(
    (p) => `zenbu:barrel?plugin=${encodeURIComponent(JSON.stringify(p))}`,
  );
  const imports = [registryUrl, ...barrelUrls];
  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    barrelUrls,
  };
}

/**
 * Generate the registry-setup module body. Side-effect only — no exports.
 * Imported FIRST by the plugins root so its `replacePlugins` /
 * `registerAppEntrypoint` calls run before any plugin's service files
 * evaluate.
 */
function buildRegistryModule(payload: RegistryPayload): string {
  const lines = [
    'import { replacePlugins, registerAppEntrypoint } from "@zenbujs/core/runtime"',
    `replacePlugins(${JSON.stringify(payload.plugins)})`,
    `registerAppEntrypoint(${JSON.stringify(payload.appEntrypoint)}, ${JSON.stringify(payload.splashPath)})`,
    "import.meta.hot?.accept()",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Generate a per-plugin barrel: just service-file imports anchored at the
 * plugin's `dir`. Glob-form entries get expanded via `fs.readdirSync` and
 * glob directories are registered with `context.hot.watch()` so dynohot
 * reloads the generated barrel when service files are added/removed.
 */
function buildPluginBarrel(plugin: ResolvedPluginRecord): {
  source: string;
  watchPaths: Set<string>;
} {
  const imports: string[] = [];
  const watchPaths = new Set<string>([plugin.dir]);

  for (const entry of plugin.services) {
    const resolved = path.isAbsolute(entry)
      ? entry
      : path.resolve(plugin.dir, entry);
    if (resolved.includes("*")) {
      const dir = path.dirname(resolved);
      watchPaths.add(dir);
      for (const file of expandGlob(resolved)) {
        imports.push(pathToFileURL(file).href);
      }
    } else {
      imports.push(pathToFileURL(resolved).href);
    }
  }

  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    watchPaths,
  };
}

// =============================================================================
//                        @zenbujs/core resolution helper
// =============================================================================

/**
 * Canonical path for `@zenbujs/core` and its subpaths, computed from the
 * loader's own URL. The loader file itself lives inside `@zenbujs/core/dist/`,
 * so the package root is two directories up. We resolve subpaths through
 * that package's `exports` field manually, instead of going through Node's
 * usual node_modules walk-up — that walk would pick up a plugin-local
 * `@zenbujs/core` (devDep) before reaching the real one. Rewriting in the
 * loader keeps `runtime.register`, `serviceWithDeps`, and the `Service`
 * class identity unique across every plugin's main-process code.
 */
type ExportEntry =
  | string
  | { import?: string; default?: string; types?: string };
type ExportsField = Record<string, ExportEntry>;

const CORE_PACKAGE_ROOT_FOR_LOADER = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = path.resolve(here, "..", "..");
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (parsed.name === "@zenbujs/core") return dir;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return path.resolve(here, "..", "..");
})();

let coreExportsCache: ExportsField | null = null;
function getCoreExports(): ExportsField | null {
  if (coreExportsCache) return coreExportsCache;
  try {
    const pkgPath = path.join(CORE_PACKAGE_ROOT_FOR_LOADER, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      name?: string;
      exports?: ExportsField;
    };
    if (pkg.name === "@zenbujs/core" && pkg.exports) {
      coreExportsCache = pkg.exports;
      return coreExportsCache;
    }
  } catch {}
  return null;
}

function resolveCoreSubpath(specifier: string): string | null {
  const exports = getCoreExports();
  if (!exports) return null;
  const sub =
    specifier === "@zenbujs/core"
      ? "."
      : "./" + specifier.slice("@zenbujs/core/".length);
  const entry = exports[sub];
  if (!entry) return null;
  const file =
    typeof entry === "string" ? entry : entry.import ?? entry.default ?? null;
  if (!file) return null;
  return path.resolve(CORE_PACKAGE_ROOT_FOR_LOADER, file);
}

// =============================================================================
//                                   hooks
// =============================================================================

export function resolve(
  specifier: string,
  context: LoaderContext,
  nextResolve: NextResolve,
): unknown {
  const start = Date.now();
  try {
    if (specifier === "@zenbu/advice/runtime") {
      return {
        url: new URL("../advice-runtime.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      specifier === "@zenbujs/core" ||
      specifier.startsWith("@zenbujs/core/")
    ) {
      const resolved = resolveCoreSubpath(specifier);
      if (resolved) {
        return {
          url: pathToFileURL(resolved).href,
          shortCircuit: true,
        };
      }
    }
    if (specifier.startsWith("zenbu:")) {
      return { url: specifier, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } finally {
    stats.resolveCount++;
    stats.resolveMs += Date.now() - start;
  }
}

function loadImpl(
  url: string,
  context: LoaderContext,
  nextLoad: NextLoad,
): unknown {
  // ─── Top-level plugins root ───
  // Triggered once at boot from setup-gate. The resolved config has been
  // pre-loaded onto `globalThis` by setup-gate (we cannot `await import` here
  // — Node serializes load hooks and a dynamic import re-enters this same
  // hook, deadlocking).
  if (url.startsWith("zenbu:plugins?")) {
    const params = new URL(url).searchParams;
    const configPath = decodeURIComponent(params.get("config") ?? "");
    const { payload, pluginSourceFiles } = getResolvedConfig(configPath);
    const { source, barrelUrls } = buildPluginsRoot(payload);
    if (context.hot?.watch) {
      context.hot.watch(pathToFileURL(configPath));
      for (const file of pluginSourceFiles) {
        context.hot.watch(pathToFileURL(file));
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated plugin root for ${path.basename(
          configPath,
        )} (${payload.plugins.length} plugins, ${barrelUrls.length} barrels)`,
      );
    }
    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  // ─── Registry-setup module (always imported first by the plugins root) ───
  if (url.startsWith("zenbu:registry?")) {
    const params = new URL(url).searchParams;
    const data = decodeURIComponent(params.get("data") ?? "");
    let payload: RegistryPayload;
    try {
      payload = JSON.parse(data);
    } catch (err) {
      throw new Error(
        `[zenbu-loader] bad registry payload: ${(err as Error).message}`,
      );
    }
    const source = buildRegistryModule(payload);
    if (verbose) {
      console.log(
        `[zenbu-loader] emitted registry module (${
          payload.plugins.length
        } plugins, entrypoint=${path.basename(payload.appEntrypoint)})`,
      );
    }
    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  // ─── Per-plugin barrel: imports the plugin's service files ───
  if (url.startsWith("zenbu:barrel?")) {
    const params = new URL(url).searchParams;
    const pluginRaw = decodeURIComponent(params.get("plugin") ?? "");
    let plugin: ResolvedPluginRecord;
    try {
      plugin = JSON.parse(pluginRaw);
    } catch (err) {
      throw new Error(
        `[zenbu-loader] bad plugin payload: ${(err as Error).message}`,
      );
    }
    const { source, watchPaths } = buildPluginBarrel(plugin);
    if (context.hot?.watch) {
      for (const watchPath of watchPaths) {
        context.hot.watch(pathToFileURL(watchPath));
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated barrel for plugin ${plugin.name} (${
          source.split("\n").filter(Boolean).length
        } imports, ${watchPaths.size} watches)`,
      );
    }
    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  return nextLoad(url, context);
}

export function load(
  url: string,
  context: LoaderContext,
  nextLoad: NextLoad,
): unknown {
  const start = Date.now();
  try {
    return loadImpl(url, context, nextLoad);
  } finally {
    stats.loadCount++;
    stats.loadMs += Date.now() - start;
  }
}
