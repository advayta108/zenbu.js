import fs from "node:fs"
import path from "node:path"

export type Manifest = {
  name: string
  services?: string[]
  schema?: string
  migrations?: string
  /**
   * Path to a `.ts` file that `export type Events = { ... }`. zen-link
   * intersects every plugin's Events into a single `PluginEvents` type
   * in `~/.zenbu/registry/events.ts`, which the rpc/event glue uses as
   * the `TEvents` parameter for `createServer<TEvents>` and
   * `connectRpc<_, TEvents>`. Lets plugins emit/subscribe to typed
   * events without touching the kernel.
   */
  events?: string
  setup?: { script?: string; version?: number }
  /**
   * Minimum kernel version required, as a semver range.
   *   "0.2.0"    — any kernel at or above 0.2.0 (bare version is a floor)
   *   ">=0.2.0"  — explicit form of the same
   *   ">=0.2 <1" — bounded range
   *
   * When set, the kernel refuses to boot with this plugin configured if its
   * own version doesn't satisfy the range. Users see a dedicated preflight
   * window with a one-click upgrade flow (fed by electron-updater).
   */
  requiredVersion?: string
}

/** Walk up from `from` until we hit a `zenbu.plugin.json`. */
export function findManifest(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    const candidate = path.join(dir, "zenbu.plugin.json")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readManifest(manifestPath: string): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
}
