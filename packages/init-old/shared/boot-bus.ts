import { sharedEventBus, type EventBus } from "./event-bus"

export type BootEvents = {
  /** Runtime announces what it's doing. Kernel forwards to the loading view. */
  status: { message: string; detail?: string }
  /** Runtime declares the app is ready; kernel swaps the orchestrator view in. */
  ready: { windowId: string }
  /** Runtime announces a fatal error during boot. */
  error: { message: string; detail?: string }
  /** Runtime is about to evaluate a service (cold boot only). */
  "service:start": { key: string; at: number }
  /** Runtime finished evaluating a service (cold boot only). */
  "service:end": { key: string; at: number; durationMs: number; error?: string }
  /**
   * A named span within the boot trace. `parentKey` points at the service key
   * (or another trace span) the work happened under; omit for root/kernel-side
   * phases. `meta` is free-form info that shows up in the boot-trace.log.
   */
  "trace:span": {
    parentKey?: string
    name: string
    startedAt: number
    durationMs: number
    error?: string
    meta?: Record<string, unknown>
  }
  /**
   * Point-in-time marker. Use for user-visible boot milestones (e.g. loading
   * screen painted, vite listening, content rendered) where only the instant
   * matters, not a duration. Renders as a single cell in the flame graph.
   */
  "trace:mark": {
    name: string
    at: number
    meta?: Record<string, unknown>
  }
}

/**
 * Shared boot bus. Bridges the kernel shell (esbuild bundle) and the
 * init-script services (tsx + dynohot) — they're in the same process but
 * different module graphs, so we route through globalThis.
 */
export const bootBus: EventBus<BootEvents> = sharedEventBus<BootEvents>("boot")

export function announceBoot(message: string, detail?: string): void {
  bootBus.emit("status", detail !== undefined ? { message, detail } : { message })
}
