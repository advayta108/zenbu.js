import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import {
  resolveBuildConfig,
  type Config,
  type Plugin,
  type ResolvedConfig,
  type ResolvedPlugin,
} from "./build-config"

const localRequire = createRequire(import.meta.url)

const CONFIG_NAMES = [
  "zenbu.config.ts",
  "zenbu.config.mts",
  "zenbu.config.js",
  "zenbu.config.mjs",
] as const

const PLUGIN_FILE_RE = /\.(?:ts|mts|js|mjs|cjs)$/

export function findConfigPath(projectDir: string): string {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(projectDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    `No zenbu config found at ${projectDir}. Expected one of: ${CONFIG_NAMES.join(", ")}`,
  )
}

let tsxRegistered: Promise<void> | null = null
function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return tsxRegistered
  tsxRegistered = (async () => {
    try {
      const tsxApi: { register?: () => unknown } = localRequire("tsx/esm/api")
      if (typeof tsxApi.register === "function") tsxApi.register()
    } catch {
      // tsx not available — caller's TS files must already be transpiled.
    }
  })()
  return tsxRegistered
}

/**
 * Dynamically import a TS module with a cache-busting query string. Each call
 * forces tsx + Node's ESM loader to re-evaluate the file. Used to rebuild
 * the resolved config + plugin set every time the loader is invoked, so a
 * change to the source TS triggers a fresh `default` export.
 *
 * The returned object is whatever the module's default export is. Older
 * defineConfig-style files that exported the object directly (no `default`)
 * also work via the `mod.default ?? mod` fallback.
 */
async function importFresh<T>(absPath: string): Promise<T> {
  await ensureTsxRegistered()
  const url = pathToFileURL(absPath).href + "?t=" + Date.now()
  const mod = (await import(url)) as { default?: T }
  return ((mod.default ?? (mod as unknown)) as T)
}

function assertPluginShape(p: unknown, source: string): asserts p is Plugin {
  if (!p || typeof p !== "object") {
    throw new Error(`${source} did not export a Plugin object.`)
  }
  const obj = p as Record<string, unknown>
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error(`${source}: plugin missing required string \`name\`.`)
  }
  if (!Array.isArray(obj.services)) {
    throw new Error(`${source}: plugin \`services\` must be an array of glob strings.`)
  }
}

function resolvePluginPaths(plugin: Plugin, dir: string): ResolvedPlugin {
  const abs = (rel: string): string =>
    path.isAbsolute(rel) ? rel : path.resolve(dir, rel)
  return {
    name: plugin.name,
    dir,
    services: plugin.services.map((s) => (path.isAbsolute(s) ? s : path.resolve(dir, s))),
    schemaPath: plugin.schema ? abs(plugin.schema) : undefined,
    migrationsPath: plugin.migrations ? abs(plugin.migrations) : undefined,
    preloadPath: plugin.preload ? abs(plugin.preload) : undefined,
    eventsPath: plugin.events ? abs(plugin.events) : undefined,
    icons: plugin.icons,
  }
}

async function resolvePluginEntry(
  entry: Plugin | string,
  configDir: string,
): Promise<{ resolved: ResolvedPlugin; sourceFile: string | null }> {
  if (typeof entry === "string") {
    const absPath = path.isAbsolute(entry) ? entry : path.resolve(configDir, entry)
    if (!PLUGIN_FILE_RE.test(absPath)) {
      throw new Error(
        `Plugin entry "${entry}" must point at a .ts/.js file (got ${path.basename(absPath)}). ` +
          `JSON plugin manifests are not supported in the new config; convert to \`zenbu.plugin.ts\`.`,
      )
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`Plugin entry "${entry}" does not exist at ${absPath}.`)
    }
    const plugin = await importFresh<Plugin>(absPath)
    assertPluginShape(plugin, absPath)
    return {
      resolved: resolvePluginPaths(plugin, path.dirname(absPath)),
      sourceFile: absPath,
    }
  }
  // Inline plugin: paths are anchored to the config file's directory because
  // that's the user's mental model when they write the inline form. The
  // alternative (e.g. anchoring to wherever the inline definePlugin call
  // lives) would be the same place 99% of the time anyway.
  assertPluginShape(entry, "(inline plugin)")
  return {
    resolved: resolvePluginPaths(entry, configDir),
    sourceFile: null,
  }
}

/**
 * Read `<projectDir>/zenbu.config.ts`, resolve all plugin entries (inline +
 * path), make every relative path absolute, and fill in `build` defaults.
 *
 * Used both by the loader (to generate the plugin barrel; cache-busted on
 * every invocation) and by CLI commands (`build:source`, `build:electron`,
 * `link`, `db generate`, `publish:source`).
 */
export async function loadConfig(projectDir: string): Promise<{
  resolved: ResolvedConfig
  /** External plugin file paths the caller should hot-watch. */
  pluginSourceFiles: string[]
}> {
  const configPath = findConfigPath(projectDir)
  const config = await importFresh<Config>(configPath)
  if (!config || typeof config !== "object") {
    throw new Error(`${configPath} default export is not a Config object.`)
  }
  if (typeof config.db !== "string" || config.db.length === 0) {
    throw new Error(
      `${configPath}: missing required \`db\` field (path to the database directory).`,
    )
  }
  if (typeof config.uiEntrypoint !== "string" || config.uiEntrypoint.length === 0) {
    throw new Error(
      `${configPath}: missing required \`uiEntrypoint\` field (path to the boot-window HTML file).`,
    )
  }
  if (!Array.isArray(config.plugins)) {
    throw new Error(`${configPath}: \`plugins\` must be an array.`)
  }

  const configDir = path.dirname(configPath)
  const dbPath = path.isAbsolute(config.db)
    ? config.db
    : path.resolve(configDir, config.db)
  const uiEntrypointPath = path.isAbsolute(config.uiEntrypoint)
    ? config.uiEntrypoint
    : path.resolve(configDir, config.uiEntrypoint)

  const plugins: ResolvedPlugin[] = []
  const pluginSourceFiles: string[] = []
  for (const entry of config.plugins) {
    const { resolved, sourceFile } = await resolvePluginEntry(entry, configDir)
    plugins.push(resolved)
    if (sourceFile) pluginSourceFiles.push(sourceFile)
  }

  const build = resolveBuildConfig(
    config.build ?? {
      source: ".",
      include: ["**/*"],
    },
  )

  return {
    resolved: {
      configPath,
      projectDir: configDir,
      dbPath,
      uiEntrypointPath,
      plugins,
      build,
    },
    pluginSourceFiles,
  }
}
