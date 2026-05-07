import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

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

type NextResolve = (
  specifier: string,
  context: LoaderContext,
) => unknown;

type NextLoad = (
  url: string,
  context: LoaderContext,
) => unknown;

type TracePort = {
  on: (event: "message", handler: (message: unknown) => void) => void;
  postMessage: (message: unknown) => void;
  unref?: () => void;
};

type InitializeData = {
  tracePort?: TracePort;
};

type BarrelGlob = {
  dir: string;
  regex: RegExp;
  snapshot: Set<string>;
};

type BarrelEntry = {
  hot?: LoaderContext["hot"];
  globs: BarrelGlob[];
};

type ParcelEvent = {
  path: string;
};

type ParcelSubscription = {
  unsubscribe: () => Promise<void>;
};

type WatcherClosable = {
  close: () => Promise<void> | void;
};

const verbose = process.env.ZENBU_VERBOSE === "1";
const requireFromHere = createRequire(import.meta.url);
const { subscribe } = requireFromHere("@parcel/watcher") as {
  subscribe: (
    dir: string,
    callback: (err: Error | null, events: ParcelEvent[]) => void,
  ) => Promise<ParcelSubscription>;
};

let registerWatcherClosable: (closable: WatcherClosable) => void = () => {};
try {
  const pause = await import("dynohot/pause");
  registerWatcherClosable =
    typeof pause.registerWatcherClosable === "function"
      ? pause.registerWatcherClosable
      : registerWatcherClosable;
} catch {}

const loaderName = "zenbu-loader";
let tracePort: TracePort | null = null;
const stats = {
  resolveCount: 0,
  resolveMs: 0,
  loadCount: 0,
  loadMs: 0,
};

const barrels = new Map<string, BarrelEntry>();
const dirWatchers = new Map<string, WatcherClosable>();

export function initialize(data?: InitializeData): void {
  if (!data?.tracePort) return;
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

function parseJsonc(str: string): unknown {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\"") {
      let j = i + 1;
      while (j < str.length) {
        if (str[j] === "\\") j += 2;
        else if (str[j] === "\"") {
          j++;
          break;
        } else {
          j++;
        }
      }
      result += str.slice(i, j);
      i = j;
    } else if (str[i] === "/" && str[i + 1] === "/") {
      i += 2;
      while (i < str.length && str[i] !== "\n") i++;
    } else if (str[i] === "/" && str[i + 1] === "*") {
      i += 2;
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }
  return JSON.parse(result.replace(/,\s*([\]}])/g, "$1"));
}

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

function snapshotDir(dir: string, regex: RegExp): Set<string> {
  if (!fs.existsSync(dir)) return new Set();
  try {
    return new Set(fs.readdirSync(dir).filter((file) => regex.test(file)));
  } catch {
    return new Set();
  }
}

function handleDirEvent(dir: string, filename: string): void {
  for (const entry of barrels.values()) {
    for (const glob of entry.globs) {
      if (glob.dir !== dir) continue;
      if (!glob.regex.test(filename)) continue;
      const nextSnapshot = snapshotDir(dir, glob.regex);
      const changed =
        nextSnapshot.size !== glob.snapshot.size ||
        [...nextSnapshot].some((file) => !glob.snapshot.has(file));
      if (!changed) continue;
      glob.snapshot = nextSnapshot;
      try {
        entry.hot?.invalidate?.();
        if (verbose) {
          console.log(
            `[zenbu-loader] invalidated barrel (${filename} added/removed in ${dir})`,
          );
        }
      } catch (err) {
        console.error("[zenbu-loader] invalidate failed:", err);
      }
      break;
    }
  }
}

function ensureDirWatcher(dir: string): void {
  if (dirWatchers.has(dir)) return;
  if (!fs.existsSync(dir)) return;

  let subscription: ParcelSubscription | null = null;
  let closed = false;

  subscribe(dir, (err, events) => {
    if (err) return;
    for (const event of events) {
      if (path.dirname(event.path) !== dir) continue;
      handleDirEvent(dir, path.basename(event.path));
    }
  })
    .then((sub) => {
      if (closed) void sub.unsubscribe().catch(() => {});
      else subscription = sub;
    })
    .catch((err: unknown) => {
      console.error(`[zenbu-loader] subscribe failed for ${dir}:`, err);
    });

  const closable = {
    close: () => {
      closed = true;
      if (subscription) return subscription.unsubscribe().catch(() => {});
    },
  };

  registerWatcherClosable(closable);
  dirWatchers.set(dir, closable);
}

function buildSource(imports: string[]): string {
  return imports.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join("");
}

function readPluginList(configPath: string): string[] {
  const raw = fs.readFileSync(configPath, "utf8");
  const config = parseJsonc(raw);
  if (
    !config ||
    typeof config !== "object" ||
    !Array.isArray((config as { plugins?: unknown }).plugins)
  ) {
    return [];
  }
  return Array.from(
    new Set(
      (config as { plugins: unknown[] }).plugins.filter(
        (plugin): plugin is string => typeof plugin === "string",
      ),
    ),
  );
}

function buildPluginRoot(configPath: string): {
  source: string;
  watchPaths: Set<string>;
} {
  const imports = readPluginList(configPath).map(
    (manifestPath) =>
      `zenbu:barrel?manifest=${encodeURIComponent(path.resolve(manifestPath))}`,
  );

  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    watchPaths: new Set([configPath]),
  };
}

function buildBarrel(manifestPath: string): {
  source: string;
  watchPaths: Set<string>;
  globs: BarrelGlob[];
} {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseJsonc(raw);
  const baseDir = path.dirname(manifestPath);
  const entries =
    manifest && typeof manifest === "object" && Array.isArray((manifest as { services?: unknown }).services)
      ? (manifest as { services: string[] }).services.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
  const imports: string[] = [];
  const watchPaths = new Set([manifestPath]);
  const globs: BarrelGlob[] = [];

  for (const entry of entries) {
    const resolved = path.resolve(baseDir, entry);
    if (resolved.includes("*")) {
      const dir = path.dirname(resolved);
      const regex = globRegex(path.basename(resolved));
      watchPaths.add(dir);
      globs.push({ dir, regex, snapshot: snapshotDir(dir, regex) });
      for (const file of expandGlob(resolved)) {
        imports.push(pathToFileURL(file).href);
      }
    } else if (resolved.endsWith(".json") || resolved.endsWith(".jsonc")) {
      imports.push(`zenbu:barrel?manifest=${encodeURIComponent(resolved)}`);
    } else {
      imports.push(pathToFileURL(resolved).href);
    }
  }

  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    watchPaths,
    globs,
  };
}

export function resolve(
  specifier: string,
  context: LoaderContext,
  nextResolve: NextResolve,
): unknown {
  const start = Date.now();
  try {
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
  if (url.startsWith("zenbu:plugins?")) {
    const params = new URL(url).searchParams;
    const configPath = decodeURIComponent(params.get("config") ?? "");
    const { source, watchPaths } = buildPluginRoot(configPath);
    if (context.hot?.watch) {
      for (const watchPath of watchPaths) {
        context.hot.watch(pathToFileURL(watchPath));
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated plugin root for ${path.basename(configPath)} (${source.split("\n").filter(Boolean).length} imports, ${watchPaths.size} watches)`,
      );
    }
    return { format: "module", source, shortCircuit: true } satisfies LoaderResult;
  }

  if (url.startsWith("zenbu:barrel?")) {
    const params = new URL(url).searchParams;
    const manifestPath = decodeURIComponent(params.get("manifest") ?? "");
    const { source, watchPaths, globs } = buildBarrel(manifestPath);
    if (context.hot?.watch) {
      for (const watchPath of watchPaths) {
        context.hot.watch(pathToFileURL(watchPath));
      }
    }
    if (context.hot) {
      barrels.set(url, { hot: context.hot, globs });
      for (const glob of globs) {
        ensureDirWatcher(glob.dir);
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated barrel for ${path.basename(manifestPath)} (${source.split("\n").filter(Boolean).length} imports, ${watchPaths.size} watches, ${globs.length} globs)`,
      );
    }
    return { format: "module", source, shortCircuit: true } satisfies LoaderResult;
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
