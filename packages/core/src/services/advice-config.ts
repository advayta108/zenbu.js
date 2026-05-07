import { runtime } from "../runtime"
import { ReloaderService } from "./reloader"
import { APP_RENDERER_RELOADER_ID } from "./renderer-host"
import { RpcService } from "./rpc"

export interface ViewAdviceEntry {
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

const RESOLVED_PREFIX = "\0@advice-prelude/"
const adviceEntries = new Map<string, ViewAdviceEntry[]>()
interface ContentScriptEntry { path: string }
const contentScripts = new Map<string, ContentScriptEntry[]>()

function invalidatePrelude(scope: string) {
  try {
    const reloader = runtime.get<ReloaderService>(ReloaderService)
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
    const rpc = runtime.get<RpcService>(RpcService)
    if (scope === "*") {
      for (const s of getAllScopes()) rpc.emit.advice.reload({ scope: s })
    } else {
      rpc.emit.advice.reload({ scope })
    }
  } catch {}
}

// --- Advice ---

export function registerAdvice(scope: string, entry: ViewAdviceEntry): () => void {
  const list = adviceEntries.get(scope) ?? []
  list.push(entry)
  adviceEntries.set(scope, list)
  emitReload(scope)

  return () => {
    const current = adviceEntries.get(scope)
    if (!current) return
    const idx = current.indexOf(entry)
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

export function registerContentScript(scope: string, modulePath: string): () => void {
  const entry: ContentScriptEntry = { path: modulePath }
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
