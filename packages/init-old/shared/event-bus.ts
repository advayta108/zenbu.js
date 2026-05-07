type Listener<T> = (payload: T) => void

/**
 * Typed pub/sub for same-process messaging. The `Events` type parameter is a
 * map of channel name → payload shape; `emit`/`on`/`once` are type-checked
 * against it.
 *
 *     type Boot = { status: { message: string } }
 *     const bus = new EventBus<Boot>()
 *     bus.on("status", ({ message }) => ...)
 *     bus.emit("status", { message: "hi" })
 *
 * Listener exceptions are logged and swallowed — one bad subscriber can't
 * break the rest.
 */
export class EventBus<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as Listener<any>)
    return () => {
      set!.delete(fn as Listener<any>)
    }
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      fn(payload)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`[event-bus] listener for "${String(event)}" threw:`, err)
      }
    }
  }

  clear(event?: keyof Events): void {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
  }
}

/**
 * Returns a process-wide singleton `EventBus` keyed by `key`.
 *
 * The kernel and the init-script run in the same Node process but are
 * evaluated by different module graphs (esbuild bundle vs. tsx + dynohot),
 * so `import`-sharing a singleton doesn't work. We stash the instance on
 * `globalThis` under a stable slot so both sides see the same bus.
 */
export function sharedEventBus<Events extends Record<string, unknown>>(
  key: string,
): EventBus<Events> {
  const g = globalThis as any
  const slot = "__zenbu_event_buses__"
  const map: Map<string, EventBus<any>> = (g[slot] ??= new Map())
  let bus = map.get(key)
  if (!bus) {
    bus = new EventBus<Events>()
    map.set(key, bus)
  }
  return bus as EventBus<Events>
}
