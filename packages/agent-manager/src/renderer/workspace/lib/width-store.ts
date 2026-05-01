import { useSyncExternalStore } from "react"

// localStorage-backed width store with a tiny pub-sub for React subscribers.
// Used by the agent + utility sidebars to keep their widths across reloads
// without round-tripping through the WS DB on every pixel of drag.

export type WidthStore = {
  get: () => number
  set: (v: number) => void
  useWidth: () => number
}

export function makeWidthStore(
  storageKey: string,
  defaultVal: number,
): WidthStore {
  const listeners = new Set<() => void>()
  let memo: number | null = null

  function read(): number {
    if (memo !== null) return memo
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw != null) {
        const n = parseInt(raw, 10)
        if (Number.isFinite(n)) {
          memo = n
          return memo
        }
      }
    } catch {}
    memo = defaultVal
    return memo
  }
  function get(): number {
    return read()
  }
  function set(next: number) {
    const rounded = Math.round(next)
    if (rounded === memo) return
    memo = rounded
    try {
      localStorage.setItem(storageKey, String(rounded))
    } catch {}
    for (const l of listeners) l()
  }
  function useWidth(): number {
    return useSyncExternalStore(
      (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      read,
      read,
    )
  }
  return { get, set, useWidth }
}

export const AGENT_SIDEBAR_STORAGE_KEY = "agent-sidebar:width"
export const UTILITY_SIDEBAR_STORAGE_KEY = "utility-sidebar:width"
export const AGENT_DEFAULT = 280
export const UTIL_DEFAULT = 320

export const agentWidthStore = makeWidthStore(
  AGENT_SIDEBAR_STORAGE_KEY,
  AGENT_DEFAULT,
)
export const utilWidthStore = makeWidthStore(
  UTILITY_SIDEBAR_STORAGE_KEY,
  UTIL_DEFAULT,
)
