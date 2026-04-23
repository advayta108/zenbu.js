import * as Effect from "effect/Effect";
/**
 * Boot-trace instrumentation for kyju's hot paths.
 *
 * Reaches the shared `bootBus` via the `globalThis.__zenbu_event_buses__` slot
 * that `packages/init/shared/event-bus.ts::sharedEventBus` populates. This
 * avoids a kyju → init import (which would be a circular dep).
 *
 * Emissions are silently ignored if no one's listening — e.g. when kyju is
 * used outside the zenbu kernel, or after the kernel's trace collector has
 * unsubscribed on `bootBus.ready`. Cost per call is one map lookup + a no-op
 * emit; effectively free in production.
 *
 * This module is **temporary instrumentation**. Once we have data to drive
 * the real optimization, revisit whether to keep these spans or gate them
 * behind a flag.
 */

type SpanEvent = {
  name: string;
  startedAt: number;
  durationMs: number;
  meta?: Record<string, unknown>;
};

const getBootBus = (): { emit: (ch: string, p: SpanEvent) => void } | null => {
  const buses = (globalThis as any).__zenbu_event_buses__ as
    | Map<string, any>
    | undefined;
  return buses?.get?.("boot") ?? null;
};

const emit = (span: SpanEvent): void => {
  const bus = getBootBus();
  if (bus) {
    try {
      bus.emit("trace:span", span);
    } catch {}
  }
};

/** Wrap an Effect with wall-time instrumentation. */
export const traceKyju = <R, E, A>(
  name: string,
  eff: Effect.Effect<A, E, R>,
  meta?: Record<string, unknown>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const result = yield* eff.pipe(
      Effect.ensuring(
        Effect.sync(() =>
          emit({ name, startedAt, durationMs: Date.now() - startedAt, meta }),
        ),
      ),
    );
    return result;
  });

/** Sync variant for non-Effect call sites. */
export const traceKyjuSync = <A>(
  name: string,
  fn: () => A,
  meta?: Record<string, unknown>,
): A => {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    emit({ name, startedAt, durationMs: Date.now() - startedAt, meta });
  }
};
