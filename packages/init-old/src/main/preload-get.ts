import type { Preloads } from "#registry/preloads"

/**
 * Access a plugin's preload result.
 *
 * Preloads are kicked off by the kernel shell BEFORE plugin-import (see
 * `apps/kernel/src/shell/index.ts`) and their resulting Promises live on a
 * process-global Map. Consumers `await` the Promise — if the preload has
 * already resolved, the await is immediate; otherwise they wait for it.
 *
 * The registry (`#registry/preloads`) is a build-time artifact written by
 * `zen link` that maps plugin names to their preload return types, giving
 * us full type safety on both the name and the result.
 *
 * Throws if `name` doesn't exist in the registry at runtime (e.g. stale
 * registry after manifest edit without re-running `zen link`).
 */
export async function getPreload<K extends keyof Preloads>(
  name: K,
): Promise<Preloads[K]> {
  const map = (globalThis as unknown as {
    __zenbu_preloads__?: Map<string, Promise<unknown>>
  }).__zenbu_preloads__
  const promise = map?.get(name as string)
  if (!promise) {
    throw new Error(
      `no preload registered for "${String(name)}" — did you add it to the plugin manifest and re-run \`zen link\`?`,
    )
  }
  return promise as Promise<Preloads[K]>
}
