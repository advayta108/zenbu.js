import { resolve, dirname, join } from "node:path"
import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import type { Plugin } from "vite"
import { zenbuAdvicePlugin } from "@zenbu/advice/vite"
import {
  getAdvice,
  getAllScopes,
  getContentScripts,
  getAllContentScriptPaths,
  type ViewAdviceEntry,
} from "../main/services/advice-config"

// ---------------------------------------------------------------------------
// Vite plugins shared by every renderer (kernel + plugin).
//
// These were previously injected by `startRendererServer` directly. They
// now live next to `view-config.ts` so a plugin's `vite.config.ts` (which
// uses `defineZenbuViewConfig()`) is a self-sufficient description of the
// view's Vite stack. `startRendererServer` only handles per-renderer
// runtime concerns (port, cacheDir, fs.strict, …) and never injects
// behavior plugins of its own.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the advice runtime entry, resolved through the same source
// layout the kernel always uses (`packages/advice/src/runtime/index.ts`).
const adviceRuntimeEntry = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "advice",
  "src",
  "runtime",
  "index.ts",
)

const PRELUDE_PREFIX = "/@advice-prelude/"
const RESOLVED_PREFIX = "\0@advice-prelude/"
const THEME_PREFIX = "/@zenbu-theme/"
const GLOBAL_THEME_PATH = resolve(homedir(), ".zenbu", "theme.css")

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readCssFile(filePath: string | null): Promise<string> {
  if (!filePath) return ""
  try {
    return await readFile(filePath, "utf-8")
  } catch (err: any) {
    if (err?.code === "ENOENT") return ""
    console.error(`[theme] failed to read ${filePath}:`, err)
    return ""
  }
}

function getScopeFromPath(urlPath: string): string | null {
  const viewMatch = urlPath.match(/^\/views\/([^/]+)\//)
  return viewMatch ? viewMatch[1] : null
}

/**
 * Resolve the view scope for a request. Aliased views (chat, plugins)
 * live under `/views/<scope>/` on the core renderer, so the path tells
 * us the scope. Own-server plugins (e.g. bottom-terminal,
 * event-log-viewer) load `/index.html` directly on their own Vite port
 * — there's no scope segment in the path. For those, the orchestrator
 * passes `?scope=<scope>` in the iframe URL and we read it from the
 * query.
 */
function resolveScope(
  urlPath: string,
  originalUrl: string | undefined,
): string | null {
  const fromPath = getScopeFromPath(urlPath)
  if (fromPath) return fromPath
  if (!originalUrl) return null
  const queryIdx = originalUrl.indexOf("?")
  if (queryIdx < 0) return null
  const params = new URLSearchParams(originalUrl.slice(queryIdx + 1))
  return params.get("scope")
}

function parsePreludeId(id: string): { scope: string } {
  const rest = id.slice(RESOLVED_PREFIX.length)
  const queryIdx = rest.indexOf("?")
  if (queryIdx < 0) return { scope: rest }
  const scope = rest.slice(0, queryIdx)
  return { scope }
}

function generatePreludeCode(entries: ViewAdviceEntry[]): string {
  if (entries.length === 0) return ""
  const imports: string[] = [
    'import { replace, advise } from "@zenbu/advice/runtime"',
  ]
  const calls: string[] = []
  entries.forEach((entry, i) => {
    const alias = `__r${i}`
    imports.push(
      `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(entry.modulePath)}`,
    )
    if (entry.type === "replace") {
      calls.push(
        `replace(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(entry.name)}, ${alias})`,
      )
    } else {
      calls.push(
        `advise(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(entry.name)}, ${JSON.stringify(entry.type)}, ${alias})`,
      )
    }
  })
  return imports.join("\n") + "\n" + calls.join("\n") + "\n"
}

/**
 * Resolves `@zenbu/advice/runtime` to the local source path. Also
 * rewrites relative `.js` imports to `.ts` when the .ts file exists, so
 * advice modules can use ESM-correct import paths and still load from
 * source during dev.
 */
export function resolveAdviceRuntime(): Plugin {
  return {
    name: "zenbu-resolve-advice-runtime",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source === "@zenbu/advice/runtime") {
        return adviceRuntimeEntry
      }
      if (importer && source.endsWith(".js")) {
        const tsPath = join(dirname(importer), source.replace(/\.js$/, ".ts"))
        if (await fileExists(tsPath)) return tsPath
      }
      return null
    },
  }
}

/**
 * Injects a `<link rel="stylesheet">` for the global theme CSS into
 * every iframe's HTML, and serves the stylesheet from a virtual
 * `/@zenbu-theme/` namespace.
 */
export function themeStylesheetPlugin(): Plugin {
  return {
    name: "zenbu-theme-stylesheets",
    enforce: "pre",

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ""
        if (!url.startsWith(THEME_PREFIX)) return next()

        const parsed = new URL(url, "http://localhost")
        if (parsed.pathname !== `${THEME_PREFIX}global.css`) return next()

        const css = await readCssFile(GLOBAL_THEME_PATH)
        res.statusCode = 200
        res.setHeader("Content-Type", "text/css; charset=utf-8")
        res.setHeader("Cache-Control", "no-cache")
        res.end(css)
      })
    },

    transformIndexHtml() {
      return [
        {
          tag: "link",
          attrs: { rel: "stylesheet", href: `${THEME_PREFIX}global.css` },
          injectTo: "body" as const,
        },
      ]
    },
  }
}

/**
 * Generates the per-iframe advice prelude module
 * (`/@advice-prelude/<scope>`) that registers all advice + content
 * scripts for a scope, and injects a `<script>` tag into the iframe's
 * HTML to load it. Also handles HMR full-reload when an advice module's
 * source file changes.
 */
export function advicePreludePlugin(): Plugin {
  return {
    name: "zenbu-advice-prelude",
    enforce: "pre",

    resolveId(source) {
      if (source.startsWith(PRELUDE_PREFIX)) {
        return RESOLVED_PREFIX + source.slice(PRELUDE_PREFIX.length)
      }
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null
      const { scope } = parsePreludeId(id)

      let code = generatePreludeCode(getAdvice(scope))
      for (const scriptPath of getContentScripts(scope)) {
        code += `import ${JSON.stringify(scriptPath)}\n`
      }

      return code || "// no advice or content scripts"
    },

    handleHotUpdate({ file, server }) {
      let matched = false
      for (const scope of getAllScopes()) {
        for (const entry of getAdvice(scope)) {
          if (file === entry.modulePath) {
            matched = true
            break
          }
        }
        if (matched) break
      }
      if (!matched) {
        matched = getAllContentScriptPaths().includes(file)
      }
      if (matched) {
        server.ws.send({ type: "full-reload" })
        return []
      }
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ""
        if (!url.startsWith(PRELUDE_PREFIX)) return next()
        try {
          const result = await server.transformRequest(url)
          if (result) {
            res.statusCode = 200
            res.setHeader("Content-Type", "application/javascript")
            res.setHeader("Cache-Control", "no-cache")
            res.end(result.code)
            return
          }
        } catch (e) {
          console.error("[advice-prelude] transform error:", e)
        }
        next()
      })
    },

    transformIndexHtml(html, ctx) {
      const scope = resolveScope(ctx.path ?? "", ctx.originalUrl)
      if (!scope) return html
      const hasAdvice = getAdvice(scope).length > 0
      const hasScripts = getContentScripts(scope).length > 0
      if (!hasAdvice && !hasScripts) return html

      return [
        {
          tag: "script",
          attrs: { type: "module", src: `${PRELUDE_PREFIX}${scope}` },
          injectTo: "head" as const,
        },
      ]
    },
  }
}

/**
 * Wraps `@zenbu/advice/vite`'s babel transform so the include filter is
 * scoped to the renderer's resolved root. Each renderer (kernel + each
 * plugin) only transforms its own files; cross-package imports
 * (#zenbu/init/...) are advised by whichever renderer originally owns
 * them, keeping advice moduleIds canonical.
 */
export function zenbuAdviceTransform(): Plugin {
  // `inner` typed as any because pnpm hoists multiple `vite` versions
  // (different peer-dep variants) and the Plugin type from `vite`
  // doesn't unify across them. The plugin shape is duck-typed at
  // runtime regardless.
  let inner: any = null
  const wrapper: Plugin = {
    name: "zenbu-advice-scoped",
    enforce: "pre",
    configResolved(config) {
      const escaped = config.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      inner = zenbuAdvicePlugin({
        root: config.root,
        include: new RegExp(`^${escaped}.*\\.[jt]sx?$`),
      })
      const hook = inner?.configResolved
      if (typeof hook === "function") {
        hook.call(this, config)
      }
    },
    transform(code, id) {
      const hook = inner?.transform
      if (typeof hook !== "function") return null
      return hook.call(this, code, id)
    },
  }
  return wrapper
}
