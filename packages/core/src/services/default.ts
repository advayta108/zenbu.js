/**
 * Loads and registers all built-in services. Kept separate from
 * `./index.ts` (which statically re-exports the service classes for
 * `serviceWithDeps(...)` consumers) so that `setup-gate` can import it without
 * eagerly loading every service module before `setupGate()` has had a
 * chance to bootstrap env vars and `process.chdir(projectRoot)`.
 */
export async function defaultServices(): Promise<void> {
  await import("./server");
  await import("./reloader");
  await import("./renderer-host");
  await import("./http");
  await import("./db");
  await import("./base-window");
  await import("./rpc");
  await import("./view-registry");
  await import("./window");
  await import("./advice-config");
}
