import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { zenbuAdvicePlugin } from "@zenbu/advice/vite";
import {
  getAdvice,
  getAllScopes,
  getContentScripts,
  getAllContentScriptPaths,
  type ViewAdviceEntry,
} from "./services/advice-config";

/**
 * Renderer-side Vite plugins that wire advice + content scripts into every
 * Zenbu view. The framework auto-injects these from `ReloaderService`; users
 * should not need to import them in their own `vite.config.ts`.
 */

const PRELUDE_PREFIX = "/@advice-prelude/";
const RESOLVED_PREFIX = "\0@advice-prelude/";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVICE_RUNTIME_ENTRY = path.resolve(HERE, "advice-runtime.mjs");

/**
 * The package directory of `@zenbujs/core` itself. We expose it on the dev
 * server's `server.fs.allow` so requests for files inside core (the bundled
 * advice runtime, vite plugin, etc.) aren't blocked by Vite's workspace
 * restriction when the host happens to live in a different workspace.
 */
const CORE_PACKAGE_ROOT = path.resolve(HERE, "..");

/**
 * Vite plugin that enforces the framework's "single React, single core"
 * invariant for every renderer iframe.
 *
 * Mechanism: `resolve.dedupe`. Vite's dedupe re-roots resolution for the
 * listed packages at the project's root `node_modules`, so a plugin's
 * `import "react"` in `plugins/<name>/src/...` doesn't walk up into its own
 * `node_modules/react` (where a peer-dep / dev-dep install would otherwise
 * land). All importers — host renderer source, plugin content scripts,
 * advice modules — collapse onto the host's single React instance.
 *
 * `@zenbujs/core` is also deduped, but in practice the symlinks created by
 * `pnpm link:` already collapse it: the host's
 * `node_modules/@zenbujs/core` and each plugin's
 * `node_modules/@zenbujs/core` resolve to the same real path on disk.
 * Adding it to `dedupe` is a belt-and-suspenders guarantee for non-pnpm
 * installs.
 *
 * Why dedupe and not absolute-path rewriting: the host's
 * `node_modules/<package>` is *inside* Vite's workspace, so files served
 * from there go through Vite's normal `/node_modules/.vite/deps/` pipeline.
 * Rewriting to a path outside the workspace forces `/@fs/...` URLs that
 * trip the workspace fs guard even with `fs.strict: false`.
 *
 * `fs.allow: [CORE_PACKAGE_ROOT]` is still added because the framework
 * itself ships a few files (e.g. `@zenbu/advice/runtime` re-exported from
 * core's dist) that the prelude pulls in directly via `/@fs/...`.
 */
export function zenbuFrameworkResolve(): Plugin {
  return {
    name: "zenbu-framework-resolve",
    enforce: "pre",

    config() {
      return {
        resolve: {
          dedupe: ["react", "react-dom", "@zenbujs/core"],
        },
        server: {
          fs: { allow: [CORE_PACKAGE_ROOT] },
        },
      };
    },

    /**
     * Vite's built-in tsconfig watcher (`reloadOnTsconfigChange` in
     * `plugins/esbuild.ts`) only triggers a cache-clear + full reload when
     * the changed path ends in exactly `/tsconfig.json` — non-canonical
     * names like `tsconfig.local.json` are silently ignored even though the
     * underlying chokidar watcher does fire on them. We use that pattern
     * (a committed `tsconfig.json` that extends a generated, gitignored
     * `tsconfig.local.json`) so plugin sources can `#registry/*`-import
     * the host's typed registry without a host-specific path leaking into
     * a committed file.
     *
     * Without this hook, every `zen link` run would silently leave esbuild
     * with a stale "extends target missing" cache and plugin sources would
     * fail to load until the dev process is killed by hand. This watches
     * the plugin directories declared in the host's `config.json` and
     * proactively calls `server.restart()` on add/change/unlink of any
     * `tsconfig.local.json`.
     */
    async configureServer(server) {
      const configPath = process.env.ZENBU_CONFIG_PATH;
      if (!configPath) return;
      const configDir = path.dirname(configPath);

      let tsconfigPaths: string[] = [];
      try {
        const raw = await fsp.readFile(configPath, "utf8");
        const config = JSON.parse(raw) as { plugins?: unknown };
        if (Array.isArray(config.plugins)) {
          for (const entry of config.plugins) {
            if (typeof entry !== "string") continue;
            const manifestAbs = path.isAbsolute(entry)
              ? entry
              : path.resolve(configDir, entry);
            tsconfigPaths.push(
              path.join(path.dirname(manifestAbs), "tsconfig.local.json"),
            );
          }
        }
      } catch {
        // Best-effort: if config.json is missing/malformed, skip — the rest
        // of the dev pipeline will already be surfacing that error.
        return;
      }
      if (tsconfigPaths.length === 0) return;
      server.watcher.add(tsconfigPaths);

      let restarting = false;
      const handle = (file: string) => {
        if (!file.endsWith("tsconfig.local.json")) return;
        if (restarting) return;
        restarting = true;
        server.config.logger.info(
          `[zenbu] ${file} changed — restarting Vite to refresh tsconfig (vite's built-in watcher only fires on /tsconfig.json)`,
          { timestamp: true, clear: false },
        );
        server
          .restart()
          .catch((err) => {
            server.config.logger.error(
              `[zenbu] vite restart failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            restarting = false;
          });
      };
      server.watcher.on("add", handle);
      server.watcher.on("change", handle);
      server.watcher.on("unlink", handle);
    },
  };
}

function getScopeFromPath(urlPath: string): string | null {
  const m = urlPath.match(/^\/views\/([^/]+)\//);
  return m ? m[1]! : null;
}

/**
 * Resolve the view scope for a request. The kernel passes `?scope=<name>`
 * in the iframe URL when opening a view (see `WindowService.openView`); we
 * also support `/views/<scope>/...` paths for plugins that register their
 * own multi-page Vite layouts.
 */
function resolveScope(
  urlPath: string,
  originalUrl: string | undefined,
): string | null {
  const fromPath = getScopeFromPath(urlPath);
  if (fromPath) return fromPath;
  if (!originalUrl) return null;
  const queryIdx = originalUrl.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(originalUrl.slice(queryIdx + 1));
  return params.get("scope");
}

function parsePreludeId(id: string): { scope: string } {
  const rest = id.slice(RESOLVED_PREFIX.length);
  const queryIdx = rest.indexOf("?");
  if (queryIdx < 0) return { scope: rest };
  return { scope: rest.slice(0, queryIdx) };
}

function generateAdvicePreludeCode(entries: ViewAdviceEntry[]): string {
  if (entries.length === 0) return "";
  const imports: string[] = [
    'import { replace, advise } from "@zenbu/advice/runtime"',
  ];
  const calls: string[] = [];
  entries.forEach((entry, i) => {
    const alias = `__r${i}`;
    imports.push(
      `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(entry.modulePath)}`,
    );
    if (entry.type === "replace") {
      calls.push(
        `replace(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(entry.name)}, ${alias})`,
      );
    } else {
      calls.push(
        `advise(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(entry.name)}, ${JSON.stringify(entry.type)}, ${alias})`,
      );
    }
  });
  return imports.join("\n") + "\n" + calls.join("\n") + "\n";
}

/**
 * Resolves `@zenbu/advice/runtime` to the bundled core runtime so plugins'
 * advice + content scripts can `import { replace, advise } from "@zenbu/advice/runtime"`
 * without depending on the package directly.
 */
export function resolveAdviceRuntime(): Plugin {
  return {
    name: "zenbu-resolve-advice-runtime",
    enforce: "pre",
    resolveId(source) {
      if (source === "@zenbu/advice/runtime") {
        return ADVICE_RUNTIME_ENTRY;
      }
      return null;
    },
  };
}

/**
 * Per-iframe prelude that registers all advice + content scripts for the
 * iframe's scope. The prelude is loaded via a `<script type="module">` tag
 * injected into the iframe's HTML; loading it before the app's own entry
 * lets advice register before the modules it patches evaluate.
 */
export function advicePreludePlugin(): Plugin {
  return {
    name: "zenbu-advice-prelude",
    enforce: "pre",

    resolveId(source) {
      if (source.startsWith(PRELUDE_PREFIX)) {
        return RESOLVED_PREFIX + source.slice(PRELUDE_PREFIX.length);
      }
      return null;
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const { scope } = parsePreludeId(id);
      let code = generateAdvicePreludeCode(getAdvice(scope));
      for (const scriptPath of getContentScripts(scope)) {
        code += `import ${JSON.stringify(scriptPath)}\n`;
      }
      return code || "// no advice or content scripts\n";
    },

    handleHotUpdate({ file, server }) {
      let matched = false;
      for (const scope of getAllScopes()) {
        for (const entry of getAdvice(scope)) {
          if (file === entry.modulePath) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        matched = getAllContentScriptPaths().includes(file);
      }
      if (matched) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
      return undefined;
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(PRELUDE_PREFIX)) return next();
        try {
          const result = await server.transformRequest(url);
          if (result) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(result.code);
            return;
          }
        } catch (e) {
          console.error("[advice-prelude] transform error:", e);
        }
        next();
      });
    },

    transformIndexHtml(html, ctx) {
      const scope = resolveScope(ctx.path ?? "", ctx.originalUrl);
      if (!scope) return html;
      const hasAdvice = getAdvice(scope).length > 0;
      const hasScripts = getContentScripts(scope).length > 0;
      if (!hasAdvice && !hasScripts) return html;
      return [
        {
          tag: "script",
          attrs: { type: "module", src: `${PRELUDE_PREFIX}${scope}` },
          injectTo: "head" as const,
        },
      ];
    },
  };
}

/**
 * Wraps `@zenbu/advice/vite`'s babel transform so the include filter is
 * scoped to the renderer's resolved root. This keeps advice moduleIds
 * canonical (each renderer transforms its own files; cross-package imports
 * stay owned by whichever renderer originally loaded them).
 */
export function zenbuAdviceTransform(): Plugin {
  let inner: any = null;
  return {
    name: "zenbu-advice-scoped",
    enforce: "pre",
    configResolved(config) {
      const escaped = config.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      inner = zenbuAdvicePlugin({
        root: config.root,
        include: new RegExp(`^${escaped}.*\\.[jt]sx?$`),
      });
      const hook = (inner as any)?.configResolved;
      if (typeof hook === "function") {
        hook.call(this, config);
      }
    },
    transform(code, id) {
      const hook = (inner as any)?.transform;
      if (typeof hook !== "function") return null;
      return hook.call(this, code, id);
    },
  };
}

/**
 * Returns the framework Vite plugins in the canonical order. Auto-injected
 * by `ReloaderService` for every renderer; exported for advanced users who
 * want to compose them into a custom Vite stack.
 *
 * Order matters:
 *   1. `zenbuFrameworkResolve` — `enforce: "pre"`, runs first so it gets
 *      `react` / `@zenbujs/core/*` *before* Vite's default resolver walks
 *      up and finds plugin-local copies.
 *   2. `advicePreludePlugin` — generates the per-iframe prelude module.
 *   3. `resolveAdviceRuntime` — points `@zenbu/advice/runtime` at core.
 *   4. `zenbuAdviceTransform` — babel transform wrapping top-level fns.
 */
export function zenbuVitePlugins(): Plugin[] {
  return [
    zenbuFrameworkResolve(),
    advicePreludePlugin(),
    resolveAdviceRuntime(),
    zenbuAdviceTransform(),
  ];
}
