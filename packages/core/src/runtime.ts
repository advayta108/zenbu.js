export type CleanupReason = "reload" | "shutdown";
type SetupCleanup = ((reason: CleanupReason) => void | Promise<void>) | void;
type SetupFn = () => SetupCleanup;

interface HotContext {
  accept(): void;
  dispose(cb: (data: any) => void | Promise<void>): void;
  prune?(cb: () => void | Promise<void>): void;
  data?: any;
}

interface ServiceSlot {
  error: unknown | null;
  instance: Service | null;
  ServiceClass: typeof Service;
  status: "blocked" | "evaluating" | "ready" | "failed";
}

type AnyServiceClass = abstract new (...args: any[]) => Service;
type DepRef = AnyServiceClass | string;
type OptionalDep<R extends DepRef = DepRef> = { __optional: true; ref: R };
type DepEntry = DepRef | OptionalDep;

type DepInstance<D> = D extends OptionalDep<infer R>
  ? R extends AnyServiceClass
    ? InstanceType<R> | undefined
    : unknown
  : D extends AnyServiceClass
  ? InstanceType<D>
  : unknown;

type ResolveCtx<TDeps> = { [K in keyof TDeps]: DepInstance<TDeps[K]> };

// TODO: Replace optional() with a reactive service tracker API, e.g.
// this.track(SomeService, { onAvailable(instance) {}, onUnavailable() {} })
// This gives both optional declaration and reactive listening in one primitive:
// the dep may not exist at evaluate-time, but when it appears (plugin loaded,
// plugin loaded) you get a callback — and a teardown when it disappears.
// Eliminates the need for manual null-checks in evaluate() and global
// onReconciled polling for a specific service key.
export function optional<R extends DepRef>(ref: R): OptionalDep<R> {
  return { __optional: true, ref };
}

function resolveDep(entry: DepEntry): { key: string; optional: boolean } {
  if (typeof entry === "string") return { key: entry, optional: false };
  if (typeof entry === "object" && entry !== null && "__optional" in entry) {
    const ref = entry.ref;
    return {
      key: typeof ref === "string" ? ref : (ref as typeof Service).key,
      optional: true,
    };
  }
  return { key: (entry as typeof Service).key, optional: false };
}

export abstract class Service {
  static key: string;
  static deps: Record<string, DepEntry>;

  ctx: any;

  /** @internal */
  __setupCleanups: Map<
    string,
    (reason: CleanupReason) => void | Promise<void>
  > = new Map();

  evaluate(): void | Promise<void> {}

  setup(key: string, fn: SetupFn): void {
    const existing = this.__setupCleanups.get(key);
    if (existing) {
      try {
        existing("reload");
      } catch (e) {
        console.error(`[hot] setup cleanup "${key}" failed:`, e);
      }
    }
    const cleanup = fn();
    if (cleanup) {
      this.__setupCleanups.set(key, cleanup);
    } else {
      this.__setupCleanups.delete(key);
    }
  }

  /**
   * Run `fn` and return its result. Historically reported a boot-trace span;
   * now a thin wrapper preserved for caller ergonomics inside service
   * `evaluate()` bodies.
   */
  trace<T>(
    _name: string,
    fn: () => T | Promise<T>,
    _meta?: Record<string, unknown>,
  ): Promise<T> {
    return Promise.resolve(fn());
  }

  traceSync<T>(_name: string, fn: () => T, _meta?: Record<string, unknown>): T {
    return fn();
  }

  /** @internal */
  async __cleanupAllSetups(reason: CleanupReason = "shutdown") {
    for (const [key, cleanup] of this.__setupCleanups) {
      try {
        await cleanup(reason);
      } catch (e) {
        console.error(`[hot] setup cleanup "${key}" failed:`, e);
      }
    }
    this.__setupCleanups.clear();
  }
}

/**
 * Declare a Service base class with typed deps. The returned class has
 * `static deps = <your map>` already set, and `this.ctx` is auto-typed
 * from the dep classes — no `declare ctx` needed in the subclass.
 *
 *     export class WindowService extends serviceWithDeps({
 *       baseWindow: BaseWindowService,
 *       http: HttpService,
 *     }) {
 *       static key = "window"
 *       evaluate() {
 *         this.ctx.baseWindow  // BaseWindowService
 *         this.ctx.http        // HttpService
 *       }
 *     }
 *
 * `optional(SomeService)` is supported and produces `Instance | undefined`.
 */
export function serviceWithDeps<TDeps extends Record<string, DepEntry>>(
  deps: TDeps,
) {
  abstract class ServiceWithDeps extends Service {
    static deps = deps as unknown as Record<string, DepEntry>;
    declare ctx: ResolveCtx<TDeps>;
  }
  return ServiceWithDeps;
}

const SERVICE_BASE_METHODS = new Set(
  Object.getOwnPropertyNames(Service.prototype),
);

export class ServiceRuntime {
  private definitions = new Map<string, typeof Service>();
  private dependentsIndex = new Map<string, Set<string>>();
  private dirtyKeys = new Set<string>();
  private drainError: unknown = null;
  private draining: Promise<void> | null = null;
  private registrationTokens = new Map<string, symbol>();
  private slots = new Map<string, ServiceSlot>();
  private onReconciledCallbacks: Array<(changedKeys: string[]) => void> = [];

  register(ServiceClass: typeof Service, importMeta?: ImportMeta | null): void {
    const hot: HotContext | null = (importMeta as any)?.hot ?? null;
    const baseKey = ServiceClass.key;
    if (!baseKey) throw new Error("Service must have a static key property");

    const slotKey = baseKey;

    this.definitions.set(slotKey, ServiceClass);
    const slot = this.slots.get(slotKey);
    if (slot) {
      slot.ServiceClass = ServiceClass;
    } else {
      this.slots.set(slotKey, {
        error: null,
        instance: null,
        ServiceClass,
        status: "blocked",
      });
    }
    this.rebuildDependentsIndex();

    hot?.accept();
    const token = Symbol(slotKey);
    this.registrationTokens.set(slotKey, token);
    hot?.prune?.(() => {
      this.unregister(slotKey, token);
    });

    void this.scheduleReconcile([slotKey]);
  }

  getAllKeys(): string[] {
    return [...this.slots.keys()];
  }

  getSlot(key: string): ServiceSlot | undefined {
    return this.slots.get(key);
  }

  async whenIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
    if (this.drainError) {
      const error = this.drainError;
      this.drainError = null;
      throw error;
    }
  }

  async reloadAll(): Promise<void> {
    const keys = [...this.slots.keys()];
    if (keys.length === 0) return;
    await this.scheduleReconcile(keys);
    await this.whenIdle();
  }

  async shutdown(): Promise<void> {
    try {
      await this.whenIdle();
    } catch (error) {
      console.error("[hot] runtime idle wait failed during shutdown:", error);
    }

    const keys = [...this.slots.keys()].reverse();
    for (const key of keys) {
      await this.teardownService(key, { removeSlot: true });
    }
    this.definitions.clear();
    this.dependentsIndex.clear();
    this.dirtyKeys.clear();
    this.registrationTokens.clear();
  }

  get<T extends Service>(ref: { key: string }): T {
    const slot = this.slots.get(ref.key);
    if (!slot || slot.status !== "ready" || !slot.instance) {
      throw new Error(
        `Service "${ref.key}" not ready. Is it registered and evaluated?`,
      );
    }
    return slot.instance as T;
  }

  buildRouter(): Record<string, Record<string, (...args: any[]) => any>> {
    const router: Record<string, Record<string, (...args: any[]) => any>> = {};

    for (const [slotKey, slot] of this.slots) {
      if (slot.status !== "ready" || !slot.instance) continue;
      const proto = Object.getPrototypeOf(slot.instance);
      const methods: Record<string, (...args: any[]) => any> = {};

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (SERVICE_BASE_METHODS.has(name)) continue;
        if (name.startsWith("_")) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== "function") continue;
        const instance = slot.instance as any;
        methods[name] = (...args: any[]) => instance[name](...args);
      }

      if (Object.keys(methods).length > 0) router[slotKey] = methods;
    }
    return router;
  }

  onReconciled(cb: (changedKeys: string[]) => void): () => void {
    this.onReconciledCallbacks.push(cb);
    return () => {
      const idx = this.onReconciledCallbacks.indexOf(cb);
      if (idx >= 0) this.onReconciledCallbacks.splice(idx, 1);
    };
  }

  private resolveDepSlot(depKey: string): ServiceSlot | undefined {
    return this.slots.get(depKey);
  }

  private injectCtx(instance: Service, ServiceClass: typeof Service): void {
    const deps =
      ((ServiceClass as any).deps as Record<string, DepEntry> | undefined) ??
      {};
    const ctx: Record<string, Service | undefined> = {};
    for (const [name, entry] of Object.entries(deps)) {
      const { key, optional: isOptional } = resolveDep(entry);
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
        if (isOptional) {
          ctx[name] = undefined;
          continue;
        }
        throw new Error(
          `Dependency "${key}" not ready for "${ServiceClass.key}"`,
        );
      }
      ctx[name] = slot.instance;
    }
    (instance as any).ctx = ctx;
  }

  private rebuildDependentsIndex(): void {
    const next = new Map<string, Set<string>>();
    for (const [slotKey, ServiceClass] of this.definitions) {
      const deps =
        ((ServiceClass as any).deps as Record<string, DepEntry> | undefined) ??
        {};
      for (const entry of Object.values(deps)) {
        const { key: depKey } = resolveDep(entry);
        const dependents = next.get(depKey) ?? new Set<string>();
        dependents.add(slotKey);
        next.set(depKey, dependents);
      }
    }
    this.dependentsIndex = next;
  }

  private getAffectedKeys(changedKeys: Iterable<string>): string[] {
    const affected = new Set<string>();
    const visit = (key: string) => {
      if (affected.has(key)) return;
      affected.add(key);
      for (const dependent of this.dependentsIndex.get(key) ?? []) {
        visit(dependent);
      }
    };
    for (const key of changedKeys) {
      visit(key);
    }
    return [...affected].filter((key) => this.definitions.has(key));
  }

  private listMissingDeps(ServiceClass: typeof Service): string[] {
    const deps =
      ((ServiceClass as any).deps as Record<string, DepEntry> | undefined) ??
      {};
    const missing: string[] = [];
    for (const entry of Object.values(deps)) {
      const { key, optional: isOptional } = resolveDep(entry);
      if (isOptional) continue;
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
        missing.push(key);
      }
    }
    return missing;
  }

  private ensureSlot(key: string, ServiceClass: typeof Service): ServiceSlot {
    const existing = this.slots.get(key);
    if (existing) return existing;
    const slot: ServiceSlot = {
      error: null,
      instance: null,
      ServiceClass,
      status: "blocked",
    };
    this.slots.set(key, slot);
    return slot;
  }

  private async teardownService(
    key: string,
    options: { removeSlot?: boolean; reason?: CleanupReason } = {},
  ): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;

    const instance = slot.instance;
    slot.instance = null;
    slot.status = "blocked";
    slot.error = null;

    if (instance) {
      await instance.__cleanupAllSetups(options.reason ?? "shutdown");
    }

    if (options.removeSlot) {
      this.slots.delete(key);
    }
  }

  private async unregister(key: string, token: symbol): Promise<void> {
    if (this.registrationTokens.get(key) !== token) return;

    this.registrationTokens.delete(key);
    this.definitions.delete(key);
    await this.teardownService(key, { removeSlot: true });
    this.rebuildDependentsIndex();
    await this.scheduleReconcile([key]);
  }

  private async scheduleReconcile(keys: Iterable<string>): Promise<void> {
    for (const key of keys) {
      this.dirtyKeys.add(key);
    }

    if (this.draining) {
      return this.draining;
    }

    this.draining = (async () => {
      try {
        while (this.dirtyKeys.size > 0) {
          const batch = [...this.dirtyKeys];
          this.dirtyKeys.clear();
          await this.reconcileBatch(batch);
        }
      } catch (error) {
        this.drainError = error;
        console.error("[hot] runtime reconcile failed:", error);
      } finally {
        this.draining = null;
        if (this.dirtyKeys.size > 0) {
          void this.scheduleReconcile([]);
        }
      }
    })();

    return this.draining;
  }

  private async reconcileBatch(changedKeys: readonly string[]): Promise<void> {
    const affectedKeys = this.getAffectedKeys(changedKeys);
    if (affectedKeys.length === 0) return;

    const affected = new Map<string, typeof Service>();
    for (const key of affectedKeys) {
      const ServiceClass = this.definitions.get(key);
      if (ServiceClass) {
        affected.set(key, ServiceClass);
      }
    }

    const levels = this.topologicalLevels(affected);

    // Phase 1: clean up all affected in REVERSE topo order (dependents before dependencies)
    for (const level of [...levels].reverse()) {
      await Promise.all(
        level.map(async (key) => {
          const slot = this.slots.get(key);
          if (slot?.instance) {
            await slot.instance.__cleanupAllSetups("reload");
          }
        }),
      );
    }

    // Phase 2: re-evaluate in forward topo order (dependencies before dependents)
    for (const level of levels) {
      await Promise.all(level.map((key) => this.reconcileKey(key)));
    }

    if (affectedKeys.length > 0) {
      for (const cb of this.onReconciledCallbacks) {
        try {
          cb(affectedKeys);
        } catch (e) {
          console.error("[hot] onReconciled callback failed:", e);
        }
      }
    }
  }

  private async reconcileKey(key: string): Promise<void> {
    const ServiceClass = this.definitions.get(key);
    if (!ServiceClass) return;

    const slot = this.ensureSlot(key, ServiceClass);
    slot.ServiceClass = ServiceClass;

    const missingDeps = this.listMissingDeps(ServiceClass);
    if (missingDeps.length > 0) {
      const shouldLog = slot.instance !== null || slot.status !== "blocked";
      await this.teardownService(key, { reason: "reload" });
      if (shouldLog) {
        console.log(`[hot] ${key} waiting on: ${missingDeps.join(", ")}`);
      }
      return;
    }

    let instance = slot.instance;
    if (!instance) {
      instance = new (ServiceClass as any)() as Service;
      slot.instance = instance;
    } else {
      Object.setPrototypeOf(instance, ServiceClass.prototype);
    }

    slot.status = "evaluating";
    slot.error = null;

    try {
      await instance!.__cleanupAllSetups("reload");
      this.injectCtx(instance!, ServiceClass);
      await instance!.evaluate();
      slot.status = "ready";
    } catch (e) {
      slot.status = "failed";
      slot.error = e;
      console.error(`[hot] ${key} failed to evaluate:`, e);
    }
  }

  private topologicalLevels(services: Map<string, typeof Service>): string[][] {
    const keys = new Set(services.keys());
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const key of keys) {
      inDegree.set(key, 0);
      dependents.set(key, []);
    }

    for (const [slotKey, ServiceClass] of services) {
      const deps =
        ((ServiceClass as any).deps as Record<string, DepEntry> | undefined) ??
        {};
      let degree = 0;
      for (const entry of Object.values(deps)) {
        const { key: depKey, optional: isOptional } = resolveDep(entry);
        if (keys.has(depKey)) {
          degree++;
          dependents.get(depKey)!.push(slotKey);
        } else if (isOptional) {
          continue;
        }
      }
      inDegree.set(slotKey, degree);
    }

    const levels: string[][] = [];
    let queue = [...keys].filter((k) => inDegree.get(k) === 0);

    while (queue.length > 0) {
      levels.push(queue);
      const next: string[] = [];
      for (const key of queue) {
        for (const dep of dependents.get(key)!) {
          const d = inDegree.get(dep)! - 1;
          inDegree.set(dep, d);
          if (d === 0) next.push(dep);
        }
      }
      queue = next;
    }

    const resolved = levels.flat();
    if (resolved.length !== keys.size) {
      const missing = [...keys].filter((k) => !resolved.includes(k));
      throw new Error(
        `Circular dependency detected involving: ${missing.join(", ")}`,
      );
    }

    return levels;
  }
}

// The runtime is a process-singleton. On a hot reload of THIS file, dynohot
// re-evaluates the module body — but `??=` keeps the existing instance so we
// don't lose every registered service. The old instance still points at the
// previous `ServiceRuntime.prototype` though, so any new methods/fixes we add
// here would be invisible to the live instance until the next process
// restart. `setPrototypeOf` after the `??=` rebinds the instance to the
// freshly-evaluated prototype, so HMR of runtime.ts itself works.

/**
 * Devtools-only handles, attached to the global so they aren't part of the
 * public `ServiceRuntime` autocomplete surface. Same shape React DevTools
 * uses (`__REACT_DEVTOOLS_GLOBAL_HOOK__`): user code reading
 * `runtime.<...>` never lands on these methods; you only find them if you
 * specifically type `globalThis.__zenbu_dev__`. Kept here (next to the
 * runtime that owns the state) because the hook reaches into private
 * implementation details — `scheduleReconcile` stays `private` on the
 * class; the cast lives inside the encapsulation boundary.
 */
function installDevHook(rt: ServiceRuntime): void {
  const internals = rt as unknown as {
    definitions: Map<string, unknown>;
    scheduleReconcile: (keys: string[]) => Promise<void>;
  };
  (globalThis as any).__zenbu_dev__ = {
    reloadService: async (key: string): Promise<void> => {
      if (!internals.definitions.has(key)) {
        throw new Error(`No service registered for key "${key}"`);
      }
      await internals.scheduleReconcile([key]);
      await rt.whenIdle();
    },
  };
}

export const runtime: ServiceRuntime = (() => {
  const existing = (globalThis as any).__zenbu_service_runtime__ as
    | ServiceRuntime
    | undefined;
  if (existing) {
    Object.setPrototypeOf(existing, ServiceRuntime.prototype);
    installDevHook(existing);
    return existing;
  }
  const fresh = new ServiceRuntime();
  (globalThis as any).__zenbu_service_runtime__ = fresh;
  installDevHook(fresh);
  return fresh;
})();
