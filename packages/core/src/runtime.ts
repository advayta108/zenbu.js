export type CleanupReason = "reload" | "shutdown";
type SetupCleanup = ((reason: CleanupReason) => void | Promise<void>) | void;
type SetupFn = () => SetupCleanup;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

function readShutdownTimeoutMs(): number {
  const raw = process.env.ZENBU_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

interface HotContext {
  accept(): void;
  dispose(cb: (data: any) => void | Promise<void>): void;
  prune?(cb: () => void | Promise<void>): void;
  data?: any;
}

interface ServiceSlot {
  error: unknown | null;
  instance: Service | null;
  ServiceClass: ServiceConstructor;
  status: "blocked" | "evaluating" | "ready" | "failed";
}

type AnyServiceClass = (abstract new (...args: any[]) => Service) & {
  key: string;
};
type DepEntry = AnyServiceClass | string;

type DepInstance<D> = D extends AnyServiceClass ? InstanceType<D> : unknown;

type ResolveCtx<TDeps> = { [K in keyof TDeps]: DepInstance<TDeps[K]> };

function resolveDepKey(entry: DepEntry): string {
  if (typeof entry === "string") return entry;
  return entry.key;
}

/**
 * A concrete service class registered with the runtime. Always has a
 * `static key` (set by `Service.create`) and an optional `static deps`
 * map. Used as the parameter type of `runtime.register`.
 */
export type ServiceConstructor = (new (...args: any[]) => Service) & {
  key: string;
  deps?: Record<string, DepEntry>;
};

export abstract class Service {
  static deps: Record<string, DepEntry> = {};

  /**
   * Define a Service base class. The returned abstract class has
   * `static key`, `static deps`, and a typed `this.ctx` already set up;
   * extend it and add your `evaluate()` body.
   *
   *     export class WindowService extends Service.create({
   *       key: "window",
   *       deps: {
   *         baseWindow: BaseWindowService,
   *         http: HttpService,
   *       },
   *     }) {
   *       evaluate() {
   *         this.ctx.baseWindow  // BaseWindowService
   *         this.ctx.http        // HttpService
   *       }
   *     }
   *
   * `key` is a required field on the config object, so TypeScript errors
   * if you forget it. `deps` is optional (defaults to no deps).
   *
   * For dynamic / optional access to another service, use
   * `runtime.get(SomeService, cb)` instead of declaring it in `deps`.
   */
  static create<
    TKey extends string,
    TDeps extends Record<string, DepEntry> = {},
  >(config: { key: TKey; deps?: TDeps }) {
    const { key, deps } = config;
    const resolvedDeps = (deps ?? {}) as Record<string, DepEntry>;
    abstract class ConfiguredService extends Service {
      static key = key;
      static deps = resolvedDeps;
      declare ctx: ResolveCtx<TDeps>;
    }
    return ConfiguredService;
  }

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

const SERVICE_BASE_METHODS = new Set(
  Object.getOwnPropertyNames(Service.prototype),
);

export class ServiceRuntime {
  private definitions = new Map<string, ServiceConstructor>();
  private dependentsIndex = new Map<string, Set<string>>();
  private dirtyKeys = new Set<string>();
  private drainError: unknown = null;
  private draining: Promise<void> | null = null;
  private registrationTokens = new Map<string, symbol>();
  private slots = new Map<string, ServiceSlot>();
  private onReconciledCallbacks: Array<(changedKeys: string[]) => void> = [];
  private subscribers = new Map<
    string,
    Set<(instance: Service | undefined) => void>
  >();

  register(
    ServiceClass: ServiceConstructor,
    importMeta?: ImportMeta | null,
  ): void {
    const hot: HotContext | null = (importMeta as any)?.hot ?? null;
    const slotKey = ServiceClass.key;
    if (typeof slotKey !== "string" || slotKey.length === 0) {
      const name = (ServiceClass as { name?: string }).name ?? "<anonymous>";
      throw new Error(
        `[runtime] service "${name}" is missing \`static key\`. ` +
          `Define it via \`Service.create({ key: "...", ... })\`.`,
      );
    }

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

  /**
   * Reload a single service by key. No-op if the key is not registered.
   * Used by infrastructure that watches resources outside dynohot's
   * import-graph (e.g. the migrations directory watcher in DbService) and
   * needs to nudge a specific service to re-evaluate without leaning on
   * the devtools-only `__zenbu_dev__.reloadService` hook.
   */
  async reload(key: string): Promise<void> {
    if (!this.slots.has(key)) return;
    await this.scheduleReconcile([key]);
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

  /**
   * Subscribe to a service. Behavior-subject style: the callback fires
   * synchronously once with the current value (the live instance if ready,
   * `undefined` otherwise), then again on every reconcile of that service —
   * so you see the new instance after each HMR. Pass through `undefined`
   * when the service tears down or unregisters.
   *
   * Returns an unsubscribe function. Always call it from a `setup()` cleanup
   * (or wherever you'd otherwise leak callbacks across reloads).
   */
  get<T extends Service>(
    ref: { key: string },
    cb: (instance: T | undefined) => void,
  ): () => void {
    const key = ref.key;
    let subs = this.subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(key, subs);
    }
    const wrapped = cb as (instance: Service | undefined) => void;
    subs.add(wrapped);

    const slot = this.slots.get(key);
    const current =
      slot?.status === "ready" && slot.instance ? (slot.instance as T) : undefined;
    try {
      cb(current);
    } catch (e) {
      console.error(`[hot] runtime.get subscriber for "${key}" threw:`, e);
    }

    return () => {
      const set = this.subscribers.get(key);
      if (!set) return;
      set.delete(wrapped);
      if (set.size === 0) this.subscribers.delete(key);
    };
  }

  private fireSubscribers(key: string): void {
    const subs = this.subscribers.get(key);
    if (!subs || subs.size === 0) return;
    const slot = this.slots.get(key);
    const instance =
      slot?.status === "ready" && slot.instance ? slot.instance : undefined;
    for (const cb of [...subs]) {
      try {
        cb(instance);
      } catch (e) {
        console.error(`[hot] runtime.get subscriber for "${key}" threw:`, e);
      }
    }
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

  private injectCtx(
    instance: Service,
    ServiceClass: ServiceConstructor,
  ): void {
    const deps = ServiceClass.deps ?? {};
    const ctx: Record<string, Service> = {};
    for (const [name, entry] of Object.entries(deps)) {
      const key = resolveDepKey(entry);
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
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
      const deps = ServiceClass.deps ?? {};
      for (const entry of Object.values(deps)) {
        const depKey = resolveDepKey(entry);
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

  private listMissingDeps(ServiceClass: ServiceConstructor): string[] {
    const deps = ServiceClass.deps ?? {};
    const missing: string[] = [];
    for (const entry of Object.values(deps)) {
      const key = resolveDepKey(entry);
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
        missing.push(key);
      }
    }
    return missing;
  }

  private ensureSlot(
    key: string,
    ServiceClass: ServiceConstructor,
  ): ServiceSlot {
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
      const reason = options.reason ?? "shutdown";
      // Bound each service's cleanup. A pty/socket/watcher whose drain
      // never resolves must not wedge the entire shutdown — emit a loud
      // log and proceed. Tune via ZENBU_SHUTDOWN_TIMEOUT_MS.
      const timeoutMs = readShutdownTimeoutMs();
      const cleanup = instance.__cleanupAllSetups(reason);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `[hot] ${key} ${reason} cleanup timed out after ${timeoutMs}ms; forcing teardown`,
          );
          resolve();
        }, timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([cleanup, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
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
    // Notify subscribers that the service is gone before dependents reconcile.
    this.fireSubscribers(key);
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

    const affected = new Map<string, ServiceConstructor>();
    for (const key of affectedKeys) {
      const ServiceClass = this.definitions.get(key);
      if (ServiceClass) {
        affected.set(key, ServiceClass);
      }
    }

    const levels = this.topologicalLevels(affected);

    // Snapshot which keys were previously ready so reconcileKey can gate the
    // "waiting on deps" log (Phase 1 nulls out the instance, erasing that signal).
    const wasReady = new Set<string>();
    for (const key of affectedKeys) {
      if (this.slots.get(key)?.status === "ready") wasReady.add(key);
    }

    // Phase 1: tear down all affected in REVERSE topo order (dependents before
    // dependencies). Full teardown — not just setup-cleanup — so each service
    // gets a fresh instance in Phase 2. We deliberately do NOT carry instance
    // state across reconciles: there is no migration hook, so reusing a stale
    // instance with a swapped prototype is a correctness footgun.
    for (const level of [...levels].reverse()) {
      await Promise.all(
        level.map((key) => this.teardownService(key, { reason: "reload" })),
      );
    }

    // Phase 2: re-evaluate in forward topo order (dependencies before dependents)
    for (const level of levels) {
      await Promise.all(level.map((key) => this.reconcileKey(key, wasReady)));
    }

    // Notify per-service subscribers (`runtime.get(ref, cb)`) with the new
    // instance — or `undefined` if the slot ended up not-ready.
    for (const key of affectedKeys) {
      this.fireSubscribers(key);
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

  private async reconcileKey(
    key: string,
    wasReady: ReadonlySet<string>,
  ): Promise<void> {
    const ServiceClass = this.definitions.get(key);
    if (!ServiceClass) return;

    const slot = this.ensureSlot(key, ServiceClass);
    slot.ServiceClass = ServiceClass;

    const missingDeps = this.listMissingDeps(ServiceClass);
    if (missingDeps.length > 0) {
      await this.teardownService(key, { reason: "reload" });
      if (wasReady.has(key)) {
        console.log(`[hot] ${key} waiting on: ${missingDeps.join(", ")}`);
      }
      return;
    }

    const instance = new (ServiceClass as any)();
    slot.instance = instance;
    slot.status = "evaluating";
    slot.error = null;

    try {
      this.injectCtx(instance, ServiceClass);
      await instance.evaluate();
      slot.status = "ready";
    } catch (e) {
      slot.status = "failed";
      slot.error = e;
      console.error(`[hot] ${key} failed to evaluate:`, e);
    }
  }

  private topologicalLevels(
    services: Map<string, ServiceConstructor>,
  ): string[][] {
    const keys = new Set(services.keys());
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const key of keys) {
      inDegree.set(key, 0);
      dependents.set(key, []);
    }

    for (const [slotKey, ServiceClass] of services) {
      const deps = ServiceClass.deps ?? {};
      let degree = 0;
      for (const entry of Object.values(deps)) {
        const depKey = resolveDepKey(entry);
        if (keys.has(depKey)) {
          degree++;
          dependents.get(depKey)!.push(slotKey);
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
/**
 * fixme: i don't think these commments make sense
 */

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

// =============================================================================
//                        Plugin / app-entrypoint registry
// =============================================================================
//
// The single source of truth for plugin metadata at runtime. Populated by the
// generated barrel (see `loaders/zenbu.ts`), which emits one
// `registerPlugin({...})` call per resolved plugin BEFORE any of that
// plugin's service files import. Consumers (services/db, vite-plugins,
// advice-config) read from here instead of walking the filesystem looking
// for `zenbu.plugin.json`.
//
// Module-singleton via `globalThis.__zenbu_plugin_registry__`, same trick as
// the service runtime, so a hot reload of THIS file keeps the existing
// registry contents.

/**
 * A plugin manifest after the loader has resolved every relative path to
 * absolute. Mirrors `ResolvedPlugin` in `cli/lib/build-config.ts` but is
 * declared inline here to avoid runtime.ts importing CLI code.
 */
export interface PluginRecord {
  name: string;
  dir: string;
  services: string[];
  schemaPath?: string;
  migrationsPath?: string;
  preloadPath?: string;
  eventsPath?: string;
  icons?: Record<string, string>;
}

interface PluginRegistry {
  plugins: Map<string, PluginRecord>;
  /** Absolute path of the renderer entrypoint directory, or null until registered. */
  appEntrypoint: string | null;
  /** Absolute path of `splash.html` inside the entrypoint dir. */
  splashPath: string | null;
  /** Subscribers that fire on every replacePlugins / registerAppEntrypoint. */
  subscribers: Set<(snapshot: ConfigSnapshot) => void>;
}

/**
 * Live snapshot of the resolved Zenbu config. Returned by `getConfig()` and
 * delivered to `subscribeConfig` callbacks. Re-emitted whenever the loader
 * regenerates the plugin barrel — i.e. on every edit to `zenbu.config.ts`
 * or any imported `zenbu.plugin.ts`.
 */
export interface ConfigSnapshot {
  plugins: PluginRecord[];
  /** Absolute path of the renderer entrypoint directory. */
  appEntrypoint: string | null;
  /** Absolute path of `splash.html` inside the entrypoint dir. */
  splashPath: string | null;
}

function getPluginRegistry(): PluginRegistry {
  const slot = globalThis as unknown as {
    __zenbu_plugin_registry__?: PluginRegistry;
  };
  if (!slot.__zenbu_plugin_registry__) {
    slot.__zenbu_plugin_registry__ = {
      plugins: new Map(),
      appEntrypoint: null,
      splashPath: null,
      subscribers: new Set(),
    };
  } else if (!slot.__zenbu_plugin_registry__.subscribers) {
    // HMR'd into an older shape; lazily fill the field.
    slot.__zenbu_plugin_registry__.subscribers = new Set();
  }
  return slot.__zenbu_plugin_registry__;
}

function snapshotConfig(reg: PluginRegistry): ConfigSnapshot {
  return {
    plugins: [...reg.plugins.values()],
    appEntrypoint: reg.appEntrypoint,
    splashPath: reg.splashPath,
  };
}

function notifySubscribers(reg: PluginRegistry): void {
  if (reg.subscribers.size === 0) return;
  const snapshot = snapshotConfig(reg);
  for (const cb of reg.subscribers) {
    try {
      cb(snapshot);
    } catch (err) {
      console.error("[zenbu config subscriber] threw:", err);
    }
  }
}

/**
 * Register a plugin's resolved manifest. Idempotent — replaces any existing
 * entry for the same `name`. Called by the loader-emitted barrel; user code
 * normally does not call this directly.
 */
export function registerPlugin(record: PluginRecord): void {
  const reg = getPluginRegistry();
  reg.plugins.set(record.name, record);
  notifySubscribers(reg);
}

/**
 * Drop a plugin from the registry. Used when the loader regenerates the
 * barrel and needs to clear stale entries.
 */
export function unregisterPlugin(name: string): void {
  const reg = getPluginRegistry();
  if (!reg.plugins.delete(name)) return;
  notifySubscribers(reg);
}

/**
 * Replace the entire plugin set in one shot. The loader uses this on every
 * barrel regeneration so removed plugins disappear cleanly.
 */
export function replacePlugins(records: PluginRecord[]): void {
  const reg = getPluginRegistry();
  reg.plugins.clear();
  for (const record of records) reg.plugins.set(record.name, record);
  notifySubscribers(reg);
}

export function getPlugins(): PluginRecord[] {
  return [...getPluginRegistry().plugins.values()];
}

export function getPlugin(name: string): PluginRecord | undefined {
  return getPluginRegistry().plugins.get(name);
}

/**
 * Set the renderer entrypoint directory + the absolute path to splash.html
 * inside it. Called once by the loader-emitted barrel. Consumers
 * (`view-registry`, `vite-plugins`, `setup-gate`'s splash window) read
 * via `getAppEntrypoint()` / `getSplashPath()`.
 */
export function registerAppEntrypoint(
  rendererDir: string,
  splashPath: string,
): void {
  const reg = getPluginRegistry();
  reg.appEntrypoint = rendererDir;
  reg.splashPath = splashPath;
  notifySubscribers(reg);
}

export function getAppEntrypoint(): string | null {
  return getPluginRegistry().appEntrypoint;
}

export function getSplashPath(): string | null {
  return getPluginRegistry().splashPath;
}

/**
 * Snapshot of the current resolved config — plugins + entrypoints. Cheap;
 * just walks the in-memory registry. The returned object is a fresh copy,
 * safe to retain or pass through serialization boundaries.
 */
export function getConfig(): ConfigSnapshot {
  return snapshotConfig(getPluginRegistry());
}

/**
 * Subscribe to config changes. The callback fires:
 *   - immediately on subscription (with the current snapshot),
 *   - after each `replacePlugins(...)` / `registerPlugin(...)` /
 *     `registerAppEntrypoint(...)` call — i.e. every time the loader
 *     regenerates the plugin barrel after a `zenbu.config.ts` edit.
 *
 * Callback exceptions are logged and swallowed so one buggy subscriber
 * can't break others. The returned function unsubscribes.
 */
export function subscribeConfig(
  callback: (snapshot: ConfigSnapshot) => void,
): () => void {
  const reg = getPluginRegistry();
  reg.subscribers.add(callback);
  // Fire once with the current snapshot so callers can initialize from a
  // single place instead of `cb(getConfig()); subscribeConfig(cb)`.
  try {
    callback(snapshotConfig(reg));
  } catch (err) {
    console.error("[zenbu config subscriber] initial fire threw:", err);
  }
  return () => {
    reg.subscribers.delete(callback);
  };
}
