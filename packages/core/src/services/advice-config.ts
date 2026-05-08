import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtime } from "../runtime"
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
 * Walk up from the given file URL until we find a `zenbu.plugin.json`. The
 * folder containing it is the plugin root and the anchor that
 * `registerContentScript` / `registerAdvice` resolve relative paths against.
 *
 * Throws (with the URL in the message) if no manifest is found, because a
 * silent fallback to `process.cwd()` would attach a content script to a
 * nonsensical location and you'd debug it by staring at empty iframes.
 */
function findPluginRoot(metaUrl: string): string {
  let dir = path.dirname(fileURLToPath(metaUrl))
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "zenbu.plugin.json"))) return dir
    dir = path.dirname(dir)
  }
  throw new Error(
    `Could not find zenbu.plugin.json walking up from ${metaUrl}. ` +
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

function invalidatePrelude(scope: string) {
  try {
    const reloader = runtime.getSlot("reloader")?.instance as
      | { get(id: string): { viteServer?: any } | undefined }
      | undefined
    if (!reloader) return
    const coreEntry = reloader.get(APP_RENDERER_RELOADER_ID)
    if (!coreEntry?.viteServer) return
    const graph = coreEntry.viteServer.moduleGraph
    const invalidateScope = (s: string) => {
      const prefix = RESOLVED_PREFIX + s
      const ids: string[] = []
      for (const id of graph.idToModuleMap.keys()) {
        if (typeof id !== "string") continue
        if (id === prefix || id.startsWith(prefix + "?")) ids.push(id)
      }
      for (const id of ids) {
        const mod = graph.getModuleById(id)
        if (mod) graph.invalidateModule(mod)
      }
    }
    if (scope === "*") {
      for (const s of getAllScopes()) invalidateScope(s)
    } else {
      invalidateScope(scope)
    }
  } catch {}
}

function emitReload(scope: string) {
  invalidatePrelude(scope)
  try {
    const rpc = runtime.getSlot("rpc")?.instance as
      | { emit: { advice: { reload(payload: { scope: string }): void } } }
      | undefined
    if (!rpc) return
    if (scope === "*") {
      for (const s of getAllScopes()) rpc.emit.advice.reload({ scope: s })
    } else {
      rpc.emit.advice.reload({ scope })
    }
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
  scope: string,
  entry: AdviceSpec,
  meta?: ImportMeta,
): () => void {
  const resolvedEntry: ViewAdviceEntry = {
    ...entry,
    modulePath: resolvePluginPath(entry.modulePath, meta),
  }
  const list = adviceEntries.get(scope) ?? []
  list.push(resolvedEntry)
  adviceEntries.set(scope, list)
  emitReload(scope)

  return () => {
    const current = adviceEntries.get(scope)
    if (!current) return
    const idx = current.indexOf(resolvedEntry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) adviceEntries.delete(scope)
    emitReload(scope)
  }
}

export function getAdvice(scope: string): ViewAdviceEntry[] {
  return adviceEntries.get(scope) ?? []
}

export function getAllAdviceScopes(): string[] {
  return [...adviceEntries.keys()]
}

// --- Content Scripts ---

/**
 * Register a content script for the given scope. `modulePath` is normally
 * a path relative to the plugin root (the folder with `zenbu.plugin.json`);
 * pass `import.meta` so we can resolve it. Absolute paths are accepted as
 * an escape hatch.
 *
 *   this.setup("inject", () =>
 *     registerContentScript("app", "src/content/clock.tsx", import.meta),
 *   )
 */
export function registerContentScript(
  scope: string,
  modulePath: string,
  meta?: ImportMeta,
): () => void {
  const resolvedPath = resolvePluginPath(modulePath, meta)
  const entry: ContentScriptEntry = { path: resolvedPath }
  const list = contentScripts.get(scope) ?? []
  list.push(entry)
  contentScripts.set(scope, list)
  emitReload(scope === "*" ? "*" : scope)

  return () => {
    const current = contentScripts.get(scope)
    if (!current) return
    const idx = current.indexOf(entry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) contentScripts.delete(scope)
    emitReload(scope === "*" ? "*" : scope)
  }
}

export function getContentScripts(scope: string): string[] {
  const scoped = (contentScripts.get(scope) ?? []).map(e => e.path)
  const global = scope !== "*" ? (contentScripts.get("*") ?? []).map(e => e.path) : []
  return [...global, ...scoped]
}

export function getAllContentScriptPaths(): string[] {
  const paths: string[] = []
  for (const list of contentScripts.values()) {
    for (const entry of list) paths.push(entry.path)
  }
  return paths
}

export function getAllScopes(): string[] {
  const scopes = new Set<string>()
  for (const k of adviceEntries.keys()) scopes.add(k)
  for (const k of contentScripts.keys()) if (k !== "*") scopes.add(k)
  return [...scopes]
}
