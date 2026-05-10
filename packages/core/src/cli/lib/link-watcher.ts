import path from "node:path"
import {
  subscribe,
  type AsyncSubscription,
} from "@parcel/watcher"
import { linkProject, type LinkProjectResult } from "../commands/link"
import type { ResolvedPlugin } from "./build-config"

interface ParcelEvent {
  path: string
  type: "create" | "update" | "delete"
}

export interface LinkWatcherOptions {
  /** Pass-through for `--registry <dir>` if the host CLI took one. */
  registryOverride?: string | null
  /** Print a one-line `[zen dev] relinked` heartbeat to stderr. */
  verbose?: boolean
}

export interface LinkWatcherHandle {
  /** Stop all subscriptions. Safe to call multiple times. */
  close(): Promise<void>
}

const RELINK_DEBOUNCE_MS = 120

// Common heavy directories we never want @parcel/watcher to recurse through.
// Native FSEvents on macOS doesn't actually need this for correctness, but
// the user-space callback fires for every change, so blacklisting hot dirs
// keeps the relink trigger from firing on (e.g.) `pnpm install` rewriting
// node_modules or `vite build` writing into dist.
const COMMON_IGNORES = [
  "**/node_modules",
  "**/.git",
  "**/.zenbu",
  "**/.next",
  "**/dist",
  "**/build",
  "**/.turbo",
  "**/.cache",
]

interface CompiledTarget {
  /** Directory the @parcel/watcher subscription will be rooted at. */
  rootDir: string
  /** Plain absolute paths whose changes should trigger a relink. */
  exactPaths: Set<string>
  /**
   * Glob-style matchers, anchored to a specific directory + filename
   * pattern. Used for service globs like `src/main/services/*.ts`.
   */
  globMatchers: Array<{ dir: string; re: RegExp }>
}

/**
 * Start a file watcher that re-runs `zen link` whenever any source the
 * link command consumes changes. Used by `zen dev` so users don't have to
 * remember to rerun `zen link` after adding a service file or editing
 * `zenbu.config.ts`.
 *
 * Failure modes:
 *   - Initial link throws (bad config): we still start the watcher so the
 *     user can recover by editing the file. The error is reported once;
 *     subsequent failed relinks during typing stay silent on purpose.
 *   - Relink throws (broken syntax mid-edit): swallowed silently. The next
 *     successful relink will catch up.
 *
 * The watcher rebuilds its subscription set after every successful relink:
 * the resolved plugin set drives which directories are watched, and that
 * set itself can change when the user edits `zenbu.config.ts` to add or
 * remove a plugin entry.
 */
export async function startLinkWatcher(
  projectDir: string,
  opts: LinkWatcherOptions = {},
): Promise<LinkWatcherHandle> {
  let subscriptions: AsyncSubscription[] = []
  let closed = false
  let relinkScheduled = false
  let relinkInFlight = false
  let relinkPending = false
  let lastWatchKey: string | null = null

  // Initial link: report errors loudly here only — once we're in the watch
  // loop, errors during typing are expected and intentionally swallowed.
  let initial: LinkProjectResult | null = null
  try {
    initial = await linkProject(projectDir, {
      registryOverride: opts.registryOverride ?? null,
      quiet: true,
    })
    if (opts.verbose) console.error(`[zen dev] initial link ok`)
  } catch (err) {
    console.error(
      `[zen dev] initial link failed (will retry on file change): ${
        err instanceof Error ? err.message : err
      }`,
    )
  }

  const compileFromResult = (result: LinkProjectResult | null): CompiledTarget[] => {
    if (!result) {
      // We have no resolved config yet — fall back to watching just the
      // project directory and the well-known config filenames so the
      // user's first save of a fixed config wakes us up.
      return [
        {
          rootDir: projectDir,
          exactPaths: new Set(
            [
              "zenbu.config.ts",
              "zenbu.config.mts",
              "zenbu.config.js",
              "zenbu.config.mjs",
            ].map((n) => path.join(projectDir, n)),
          ),
          globMatchers: [],
        },
      ]
    }
    return compileTargets(result)
  }

  const subscribeAll = async (targets: CompiledTarget[]): Promise<void> => {
    await teardownAll()
    if (closed) return
    for (const target of targets) {
      try {
        const sub = await subscribe(
          target.rootDir,
          (err, events) => {
            if (err) return
            if (!eventsAreRelevant(events, target)) return
            scheduleRelink()
          },
          { ignore: COMMON_IGNORES },
        )
        if (closed) {
          await sub.unsubscribe().catch(() => {})
          return
        }
        subscriptions.push(sub)
      } catch (err) {
        if (opts.verbose) {
          console.error(
            `[zen dev] watcher subscribe failed for ${target.rootDir}: ${
              err instanceof Error ? err.message : err
            }`,
          )
        }
      }
    }
  }

  const teardownAll = async (): Promise<void> => {
    const subs = subscriptions
    subscriptions = []
    await Promise.all(
      subs.map((s) => s.unsubscribe().catch(() => {})),
    )
  }

  const reconcileSubscriptions = async (
    result: LinkProjectResult | null,
  ): Promise<void> => {
    const targets = compileFromResult(result)
    const key = watchKey(targets)
    if (key === lastWatchKey) return
    lastWatchKey = key
    await subscribeAll(targets)
  }

  await reconcileSubscriptions(initial)

  function scheduleRelink(): void {
    if (closed) return
    if (relinkInFlight) {
      relinkPending = true
      return
    }
    if (relinkScheduled) return
    relinkScheduled = true
    setTimeout(() => {
      relinkScheduled = false
      void runRelink()
    }, RELINK_DEBOUNCE_MS)
  }

  async function runRelink(): Promise<void> {
    if (closed) return
    relinkInFlight = true
    try {
      const result = await linkProject(projectDir, {
        registryOverride: opts.registryOverride ?? null,
        quiet: true,
      })
      if (opts.verbose) console.error(`[zen dev] relinked`)
      await reconcileSubscriptions(result)
    } catch {
      // Intentional silence: relinks fail constantly while the user is
      // mid-keystroke (parse errors, half-written imports, file moves).
      // Logging would spam the dev terminal. The next successful relink
      // will overwrite whatever stale registry types are on disk.
    } finally {
      relinkInFlight = false
      if (relinkPending && !closed) {
        relinkPending = false
        scheduleRelink()
      }
    }
  }

  return {
    async close() {
      closed = true
      await teardownAll()
    },
  }
}

/**
 * Build the set of (directory, filter) pairs we need watchers for. The
 * filter side matters: we subscribe recursively to a dir but only treat
 * matching events as link-relevant.
 *
 * The set covers everything `linkProject` reads:
 *   - the `zenbu.config.ts` itself,
 *   - any `zenbu.plugin.ts` files imported from the config,
 *   - per-plugin schema/preload/events/migrations files,
 *   - per-plugin service glob expansions.
 */
function compileTargets(result: LinkProjectResult): CompiledTarget[] {
  const exactPaths = new Set<string>([result.resolvedConfigPath])
  for (const f of result.pluginSourceFiles) exactPaths.add(f)
  const globMatchers: Array<{ dir: string; re: RegExp }> = []

  // Collect every directory that contributes to the link output. We pick
  // a minimal cover (drop directories that are descendants of another
  // included directory) so @parcel/watcher's recursive subscription only
  // installs once per ancestor.
  const candidateDirs = new Set<string>()
  candidateDirs.add(path.dirname(result.resolvedConfigPath))
  for (const f of result.pluginSourceFiles) {
    candidateDirs.add(path.dirname(f))
  }
  for (const plugin of result.resolved.plugins) {
    addPluginPaths(plugin, exactPaths, globMatchers, candidateDirs)
  }

  const minimalDirs = minimalCover([...candidateDirs])

  return minimalDirs.map((rootDir) => ({
    rootDir,
    exactPaths,
    globMatchers,
  }))
}

function addPluginPaths(
  plugin: ResolvedPlugin,
  exactPaths: Set<string>,
  globMatchers: Array<{ dir: string; re: RegExp }>,
  candidateDirs: Set<string>,
): void {
  candidateDirs.add(plugin.dir)
  for (const p of [
    plugin.schemaPath,
    plugin.preloadPath,
    plugin.eventsPath,
    plugin.migrationsPath,
  ]) {
    if (p) {
      exactPaths.add(p)
      candidateDirs.add(path.dirname(p))
    }
  }
  for (const serviceGlobAbs of plugin.services) {
    if (!serviceGlobAbs.includes("*")) {
      // Concrete path, not a glob.
      exactPaths.add(serviceGlobAbs)
      candidateDirs.add(path.dirname(serviceGlobAbs))
      continue
    }
    const dir = path.dirname(serviceGlobAbs)
    const base = path.basename(serviceGlobAbs)
    // Mirror the limited glob support in `expandGlob` over in link.ts:
    // only `*` is meaningful; everything else is a literal.
    const re = new RegExp(
      "^" + base.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    )
    globMatchers.push({ dir, re })
    candidateDirs.add(dir)
  }
}

function eventsAreRelevant(
  events: ParcelEvent[],
  target: CompiledTarget,
): boolean {
  for (const event of events) {
    const abs = event.path
    if (target.exactPaths.has(abs)) return true
    for (const { dir, re } of target.globMatchers) {
      if (path.dirname(abs) === dir && re.test(path.basename(abs))) return true
    }
  }
  return false
}

function minimalCover(dirs: string[]): string[] {
  const unique = [...new Set(dirs.map((d) => path.resolve(d)))]
  unique.sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const d of unique) {
    const isContained = kept.some(
      (k) => d === k || d.startsWith(k + path.sep),
    )
    if (!isContained) kept.push(d)
  }
  return kept
}

function watchKey(targets: CompiledTarget[]): string {
  // Cheap structural key: rooted dirs + exact-path set + glob matchers.
  // We compare these to decide whether a successful relink changed the
  // watch surface (e.g. user added a new plugin to zenbu.config.ts).
  const parts: string[] = []
  for (const t of targets) {
    const exacts = [...t.exactPaths].sort().join("|")
    const globs = t.globMatchers
      .map((m) => `${m.dir}::${m.re.source}`)
      .sort()
      .join("|")
    parts.push(`${t.rootDir}<<${exacts}>>${globs}`)
  }
  return parts.sort().join("\n")
}
