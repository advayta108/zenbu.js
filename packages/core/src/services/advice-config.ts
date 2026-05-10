import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtime, getPlugins } from "../runtime"
// NOTE: do NOT import ReloaderService / RendererHostService / RpcService at the
// top of this module. This file is reachable from `services/reloader.ts`
// through `vite-plugins.ts`, and a top-level circular import means the dep
// classes used below would resolve to `undefined` during the very first eval
// pass — and *some other* service's `static deps = { reloader: ReloaderService }`
// would close over an `undefined`, taking out the runtime's dep resolver.
// Resolve those services lazily inside the few functions that need them
// (after all modules have finished evaluating).

export interface ViewAdviceEntry {
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/**
 * Find the plugin whose `dir` contains the file at `metaUrl`. The runtime
 * plugin registry (populated by the loader-emitted barrel) is the source
 * of truth; this no longer walks the filesystem looking for
 * `zenbu.plugin.json`. Returns the plugin's dir, used as the anchor for
 * `registerContentScript` / `registerAdvice` relative-path resolution.
 *
 * Throws if no plugin matches, because a silent fallback to `process.cwd()`
 * would attach a content script to a nonsensical location and you'd debug
 * it by staring at empty iframes.
 */
function findPluginRoot(metaUrl: string): string {
  const file = fileURLToPath(metaUrl)
  let bestMatch: { dir: string; depth: number } | null = null
  for (const plugin of getPlugins()) {
    const rel = path.relative(plugin.dir, file)
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue
    const depth = plugin.dir.split(path.sep).length
    if (!bestMatch || depth > bestMatch.depth) {
      bestMatch = { dir: plugin.dir, depth }
    }
  }
  if (bestMatch) return bestMatch.dir
  throw new Error(
    `Could not find owning plugin for ${metaUrl}. ` +
      `Pass an absolute path, or call this from a file inside a Zenbu plugin.`,
  )
}

/**
 * Accepts either an absolute path (used as-is) or a path relative to the
 * caller's plugin root. The `meta` argument is `import.meta` from the calling
 * module; without it we can't compute the plugin root, so relative paths
 * require it.
 */
function resolvePluginPath(
  modulePath: string,
  meta?: ImportMeta,
): string {
  if (path.isAbsolute(modulePath)) return modulePath
  if (!meta?.url) {
    throw new Error(
      `registerContentScript/registerAdvice: relative path "${modulePath}" requires import.meta as the second argument so we can find the plugin root.`,
    )
  }
  return path.resolve(findPluginRoot(meta.url), modulePath)
}

const RESOLVED_PREFIX = "\0@advice-prelude/"
const APP_RENDERER_RELOADER_ID = "app"
const adviceEntries = new Map<string, ViewAdviceEntry[]>()
interface ContentScriptEntry { path: string }
const contentScripts = new Map<string, ContentScriptEntry[]>()

function invalidatePrelude(type: string) {
  try {
    const reloader = runtime.getSlot("reloader")?.instance as
      | { get(id: string): { viteServer?: any } | undefined }
      | undefined
    if (!reloader) return
    const coreEntry = reloader.get(APP_RENDERER_RELOADER_ID)
    if (!coreEntry?.viteServer) return
    const graph = coreEntry.viteServer.moduleGraph
    const invalidateMatching = (test: (id: string) => boolean) => {
      const ids: string[] = []
      for (const id of graph.idToModuleMap.keys()) {
        if (typeof id !== "string") continue
        if (test(id)) ids.push(id)
      }
      for (const id of ids) {
        const mod = graph.getModuleById(id)
        if (mod) graph.invalidateModule(mod)
      }
    }
    if (type === "*") {
      // A wildcard registration (applies to every view) changes the prelude
      // content for *every* type, so invalidate every prelude module
      // currently in the graph rather than scanning a per-type prefix.
      invalidateMatching((id) => id.startsWith(RESOLVED_PREFIX))
    } else {
      const prefix = RESOLVED_PREFIX + type
      invalidateMatching(
        (id) => id === prefix || id.startsWith(prefix + "?"),
      )
    }
  } catch {}
}

function emitReload(type: string) {
  invalidatePrelude(type)
  try {
    const rpc = runtime.getSlot("rpc")?.instance as
      | { emit: { advice: { reload(payload: { type: string }): void } } }
      | undefined
    if (!rpc) return
    // `"*"` is a sentinel that every connected iframe treats as "reload me
    // regardless of my view type". Don't fan out over `getAllTypes()` here —
    // when only a wildcard registration exists the fan-out is empty and the
    // event silently disappears.
    rpc.emit.advice.reload({ type })
  } catch {}
}

// --- Advice ---

/**
 * Public-facing advice spec. `modulePath` is normally a path relative to
 * the plugin root (the folder containing `zenbu.plugin.json`); pass
 * `import.meta` as the second argument so we can resolve it. Absolute
 * paths are also accepted as an escape hatch.
 */
export type AdviceSpec = Omit<ViewAdviceEntry, "modulePath"> & {
  modulePath: string
}

export function registerAdvice(
  type: string,
  entry: AdviceSpec,
  meta?: ImportMeta,
): () => void {
  const resolvedEntry: ViewAdviceEntry = {
    ...entry,
    modulePath: resolvePluginPath(entry.modulePath, meta),
  }
  const list = adviceEntries.get(type) ?? []
  list.push(resolvedEntry)
  adviceEntries.set(type, list)
  emitReload(type)

  return () => {
    const current = adviceEntries.get(type)
    if (!current) return
    const idx = current.indexOf(resolvedEntry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) adviceEntries.delete(type)
    emitReload(type)
  }
}

export function getAdvice(type: string): ViewAdviceEntry[] {
  return adviceEntries.get(type) ?? []
}

export function getAllAdviceTypes(): string[] {
  return [...adviceEntries.keys()]
}

// --- Content Scripts ---

/**
 * Register a content script for the given view type. `modulePath` is normally
 * a path relative to the plugin root (the folder with `zenbu.plugin.json`);
 * pass `import.meta` so we can resolve it. Absolute paths are accepted as
 * an escape hatch.
 *
 *   this.setup("inject", () =>
 *     registerContentScript("app", "src/content/clock.tsx", import.meta),
 *   )
 */
export function registerContentScript(
  type: string,
  modulePath: string,
  meta?: ImportMeta,
): () => void {
  const resolvedPath = resolvePluginPath(modulePath, meta)
  const entry: ContentScriptEntry = { path: resolvedPath }
  const list = contentScripts.get(type) ?? []
  list.push(entry)
  contentScripts.set(type, list)
  emitReload(type === "*" ? "*" : type)

  return () => {
    const current = contentScripts.get(type)
    if (!current) return
    const idx = current.indexOf(entry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) contentScripts.delete(type)
    emitReload(type === "*" ? "*" : type)
  }
}

export function getContentScripts(type: string): string[] {
  const scoped = (contentScripts.get(type) ?? []).map(e => e.path)
  const global = type !== "*" ? (contentScripts.get("*") ?? []).map(e => e.path) : []
  return [...global, ...scoped]
}

export function getAllContentScriptPaths(): string[] {
  const paths: string[] = []
  for (const list of contentScripts.values()) {
    for (const entry of list) paths.push(entry.path)
  }
  return paths
}

export function getAllTypes(): string[] {
  const types = new Set<string>()
  for (const k of adviceEntries.keys()) types.add(k)
  for (const k of contentScripts.keys()) if (k !== "*") types.add(k)
  return [...types]
}
