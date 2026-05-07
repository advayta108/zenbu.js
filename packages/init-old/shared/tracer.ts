import { bootBus } from "./boot-bus"

export interface SpanOptions {
  /** Service key (or trace name) this span belongs under. Omit for root. */
  parentKey?: string
  meta?: Record<string, unknown>
}

/**
 * Wrap `fn` in a trace span. Reports duration via `bootBus` so the kernel
 * boot-trace collector can render it. Catches errors, records them, and
 * re-throws so call sites don't change semantics.
 *
 *     await trace("discover-sections", () => discoverSections(), { parentKey: "db" })
 */
export async function trace<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts: SpanOptions = {},
): Promise<T> {
  const startedAt = Date.now()
  let error: string | undefined
  try {
    return await fn()
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    bootBus.emit("trace:span", {
      parentKey: opts.parentKey,
      name,
      startedAt,
      durationMs: Date.now() - startedAt,
      error,
      meta: opts.meta,
    })
  }
}

/**
 * Record a point-in-time boot milestone (e.g. "window-visible", "vite-ready").
 * The renderer shows marks as single-cell markers in the flame graph — useful
 * when you care *when* something happened, not *how long* it took.
 */
export function mark(name: string, meta?: Record<string, unknown>): void {
  bootBus.emit("trace:mark", { name, at: Date.now(), meta })
}

/** Sync variant — same contract, no `await`. */
export function traceSync<T>(
  name: string,
  fn: () => T,
  opts: SpanOptions = {},
): T {
  const startedAt = Date.now()
  let error: string | undefined
  try {
    return fn()
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    bootBus.emit("trace:span", {
      parentKey: opts.parentKey,
      name,
      startedAt,
      durationMs: Date.now() - startedAt,
      error,
      meta: opts.meta,
    })
  }
}
