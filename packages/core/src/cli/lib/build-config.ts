// Build pipeline shape used by `zen build:source` and `zen build:electron`.
// User code authors a `build` field inside `zenbu.config.ts` via
// `defineBuildConfig(...)`, or imports just the helpers when they want to
// extract build into a separate file.

export interface TransformInput {
  path: string
  code: string
}

export interface TransformOutput {
  code?: string
  drop?: boolean
}

export type Transform = (file: TransformInput) => TransformOutput | null | undefined | void

export interface MirrorConfig {
  target: string
  branch?: string
}

export interface BundleConfig {
  extraResources?: string[]
}

export interface BuildConfig {
  source?: string
  out?: string
  include: string[]
  ignore?: string[]
  transforms?: Transform[]
  mirror?: MirrorConfig
  bundle?: BundleConfig
}

export function defineBuildConfig(config: BuildConfig): BuildConfig {
  return config
}

export type ResolvedBuildConfig = Required<Omit<BuildConfig, "mirror" | "bundle">> & {
  mirror?: MirrorConfig
  bundle?: BundleConfig
}

export function resolveBuildConfig(config: BuildConfig): ResolvedBuildConfig {
  return {
    source: config.source ?? ".",
    out: config.out ?? ".zenbu/build/source",
    include: config.include,
    ignore: config.ignore ?? [],
    transforms: config.transforms ?? [],
    mirror: config.mirror,
    bundle: config.bundle,
  }
}

// =============================================================================
//                                Plugin shape
// =============================================================================

/**
 * A Zenbu plugin's main-process surface. Plugins are pure main-process: they
 * register services + side-effect modules (schema, preload, events). UI is
 * handled exclusively at the outer config level via `uiEntrypoint` — there
 * is exactly one HTML entrypoint per app.
 *
 * `services` is an array of glob patterns (relative to the plugin file's
 * directory). `schema` / `preload` / `events` are optional file paths.
 */
export interface Plugin {
  name: string
  services: string[]
  schema?: string
  migrations?: string
  preload?: string
  events?: string
  /**
   * Plugin-author-defined SVG icons keyed by view scope. Read by
   * `view-registry` to decorate registered views. Optional.
   */
  icons?: Record<string, string>
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}

/**
 * A plugin manifest after path resolution. Every relative path has been made
 * absolute against `dir` (the directory the manifest came from). Glob-form
 * service entries stay as patterns (still anchored to `dir`).
 *
 * The runtime stores these in `runtime.getPlugins()`; consumers like
 * `services/db.ts`, `services/advice-config.ts`, `vite-plugins.ts` read from
 * there instead of walking the filesystem looking for `zenbu.plugin.json`.
 */
export interface ResolvedPlugin {
  name: string
  /** Absolute directory the plugin was loaded from. */
  dir: string
  /** Glob patterns for service files. Anchored to `dir`. */
  services: string[]
  /** Absolute path to `schema.ts` (or undefined). */
  schemaPath?: string
  /** Absolute path to migrations dir/file (or undefined). */
  migrationsPath?: string
  /** Absolute path to `preload.ts` (or undefined). */
  preloadPath?: string
  /** Absolute path to `events.ts` (or undefined). */
  eventsPath?: string
  /** Plugin-author-defined SVG icons. */
  icons?: Record<string, string>
}

// =============================================================================
//                                 Top-level config
// =============================================================================

/**
 * The whole-app `zenbu.config.ts` shape. Authored by user code; imported
 * (and re-imported on every change) by the loader and CLI.
 *
 * - `db`: directory the kyju database lives in (relative to the config file).
 * - `uiEntrypoint`: path to the boot-window's HTML file. Exactly one — there
 *   is no per-plugin UI (today's per-plugin `uiEntrypoint` was effectively a
 *   bug that the new shape disallows at the type level).
 * - `plugins`: flat list. Each entry is either an inline `definePlugin({...})`
 *   or a path to a `zenbu.plugin.ts` whose default export is a plugin. The
 *   "host plugin" is just `plugins[0]` by convention; nothing structurally
 *   distinguishes it.
 * - `build`: shipped as `defineBuildConfig({...})`. Drives `zen build:source`
 *   and `zen build:electron`.
 */
export interface Config {
  db: string
  uiEntrypoint: string
  plugins: Array<Plugin | string>
  build?: BuildConfig
}

export function defineConfig(config: Config): Config {
  return config
}

export interface ResolvedConfig {
  /** Absolute path to the `zenbu.config.ts` this came from. */
  configPath: string
  /** Directory containing `zenbu.config.ts`. */
  projectDir: string
  /** Absolute path to the database directory. */
  dbPath: string
  /** Absolute path to the boot-window HTML. */
  uiEntrypointPath: string
  plugins: ResolvedPlugin[]
  /** Resolved build config; defaults filled in even when user omits. */
  build: ResolvedBuildConfig
}
