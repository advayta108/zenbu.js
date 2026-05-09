import path from "node:path"

/**
 * Resolve an env object suitable for spawning a user-installed binary
 * (Claude, codex, arbitrary terminal commands) — i.e. with the user's
 * login-shell PATH prepended to the inherited PATH.
 *
 * The shell probe runs as the kernel preload in parallel with plugin-import,
 * so by the time spawn sites await this, the Promise is usually already
 * resolved. First use in a rare race case waits ~0-800ms; all subsequent
 * calls are instant because the preload resolves once per process.
 *
 * Deliberately hard-codes the `"kernel"` preload name rather than going
 * through `getPreload`: this module lives in `@zenbu/agent`, which is a
 * dependency of the kernel preload host, so importing from there would
 * cycle. The type safety provided by the registry isn't critical here
 * since the call site is a single well-understood lookup.
 */
export async function applyUserShellPath(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const map = (globalThis as unknown as {
    __zenbu_preloads__?: Map<string, Promise<unknown>>
  }).__zenbu_preloads__
  const promise = map?.get("kernel") as
    | Promise<{ pathExtras: string[] }>
    | undefined
  if (!promise) return env
  let preload: { pathExtras: string[] }
  try {
    preload = await promise
  } catch {
    return env
  }
  if (!preload.pathExtras.length) return env
  const existing = env.PATH ?? ""
  return {
    ...env,
    PATH: [...preload.pathExtras, existing]
      .filter(Boolean)
      .join(path.delimiter),
  }
}
