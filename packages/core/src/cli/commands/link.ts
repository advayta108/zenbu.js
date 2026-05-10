import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "../lib/load-config"
import type { ResolvedPlugin } from "../lib/build-config"

type ServiceEntry = { className: string; key: string; filePath: string }
type SchemaEntry = { name: string; schemaPath: string }
type PreloadEntry = { name: string; preloadPath: string }
type EventsEntry = { name: string; eventsPath: string }
type LinkConfig = {
  name: string
  services?: string[]
  schema?: string
  preload?: string
  events?: string
  devAppPath?: string
}

const CONFIG_NAMES = ["zenbu.config.ts", "zenbu.config.mts", "zenbu.config.js", "zenbu.config.mjs"]

function findProjectDir(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    for (const name of CONFIG_NAMES) {
      if (fs.existsSync(path.join(dir, name))) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function findFileUp(from: string, name: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** jsonc-lite: strips // and /* * / comments and trailing commas. */
function readJsonLoose(filePath: string): any {
  const raw = fs.readFileSync(filePath, "utf8")
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([\]}])/g, "$1")
  return JSON.parse(stripped)
}

/**
 * Extract the `#registry/*` mapping from a tsconfig (typically a
 * gitignored `tsconfig.local.json`) and return the absolute directory it
 * resolves to. Returns null when the alias isn't declared.
 */
function readRegistryDirFromTsconfig(tsconfigPath: string): string | null {
  try {
    const cfg = readJsonLoose(tsconfigPath)
    const entry = cfg?.compilerOptions?.paths?.["#registry/*"]
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return null
    const raw = entry[0] as string
    const trimmed = raw.replace(/\/\*$/, "")
    const baseUrl = typeof cfg?.compilerOptions?.baseUrl === "string"
      ? path.resolve(path.dirname(tsconfigPath), cfg.compilerOptions.baseUrl)
      : path.dirname(tsconfigPath)
    return path.resolve(baseUrl, trimmed)
  } catch {
    return null
  }
}

/**
 * An app root is the nearest ancestor (or self) that contains a
 * `zenbu.config.ts` (or its .mts/.js/.mjs variants). That single file
 * uniquely identifies a Zenbu project root.
 */
function findAppRoot(from: string): string | null {
  return findProjectDir(from)
}

/**
 * Pick the directory `zen link` should write registry types into.
 * Resolution order:
 *   1. `--registry <dir>` flag / `ZENBU_REGISTRY_DIR` env (escape hatch)
 *   2. Nearest `tsconfig.local.json` ancestor's `#registry/*` mapping
 *      (canonical — this is the same path TS uses to resolve the alias)
 *   3. The manifest's `devAppPath` field (dev hint, fallback)
 *   4. Walk up to the host app root and use `<app>/types`
 *   5. Fail with a message that explains the available knobs
 */
function resolveRegistryDir(opts: {
  manifestPath: string
  manifest: { devAppPath?: string }
  registryOverride: string | null
}): string {
  if (opts.registryOverride) return path.resolve(opts.registryOverride)
  if (process.env.ZENBU_REGISTRY_DIR) return path.resolve(process.env.ZENBU_REGISTRY_DIR)

  const manifestDir = path.dirname(opts.manifestPath)

  const tsconfigLocal = findFileUp(manifestDir, "tsconfig.local.json")
  if (tsconfigLocal) {
    const fromTs = readRegistryDirFromTsconfig(tsconfigLocal)
    if (fromTs) return fromTs
  }

  if (opts.manifest.devAppPath) {
    return path.resolve(manifestDir, opts.manifest.devAppPath, "types")
  }

  const appRoot = findAppRoot(manifestDir)
  if (appRoot) return path.join(appRoot, "types")

  throw new Error(
    `zen link: could not determine target types directory for ${opts.manifestPath}.\n` +
      `         Try one of:\n` +
      `         - run from inside an app dir (with a zenbu.config.ts),\n` +
      `         - add a "devAppPath" field to ${path.basename(opts.manifestPath)} pointing at the host app,\n` +
      `         - create a tsconfig.local.json with a "#registry/*" path mapping,\n` +
      `         - or pass --registry <dir>.`,
  )
}

function expandGlob(baseDir: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    const full = path.resolve(baseDir, pattern)
    return fs.existsSync(full) ? [full] : []
  }
  const dir = path.resolve(baseDir, path.dirname(pattern))
  const filePattern = path.basename(pattern)
  const regex = new RegExp(
    "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  )
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => regex.test(f))
      .map((f) => path.resolve(dir, f))
  } catch {
    return []
  }
}

function discoverServices(baseDir: string, serviceGlobs: string[]): ServiceEntry[] {
  const entries: ServiceEntry[] = []
  // Matches the canonical service shape and pulls out both the class name
  // and the key from the same regex:
  //   export class Foo extends Service.create({
  //     key: "foo",
  //     ...
  //   })
  const classKeyRe =
    /export\s+class\s+(\w+)\s+extends\s+Service\.create\s*\(\s*\{[\s\S]*?\bkey\s*:\s*["']([^"']+)["']/
  for (const glob of serviceGlobs) {
    for (const filePath of expandGlob(baseDir, glob)) {
      const content = fs.readFileSync(filePath, "utf8")
      const match = content.match(classKeyRe)
      if (match) {
        entries.push({
          className: match[1]!,
          key: match[2]!,
          filePath,
        })
      }
    }
  }
  return entries
}

function relativeFromRegistry(registryDir: string, absPath: string): string {
  let rel = path.relative(registryDir, absPath)
  if (!rel.startsWith(".")) rel = "./" + rel
  return rel.replace(/\.ts$/, "")
}

const SERVICE_BASE_LITERAL = [
  `  | "evaluate"`,
  `  | "shutdown"`,
  `  | "constructor"`,
  `  | "effect"`,
  `  | "__cleanupAllEffects"`,
  `  | "__effectCleanups"`,
  `  | "ctx"`,
].join("\n")

function generateServicesFile(
  registryDir: string,
  allServices: Map<string, ServiceEntry[]>,
): string {
  const imports: string[] = []
  const routerEntries: string[] = []
  const usedNames = new Map<string, number>()
  function uniqueName(base: string): string {
    const count = usedNames.get(base) ?? 0
    usedNames.set(base, count + 1)
    return count === 0 ? base : `${base}_${count}`
  }
  for (const [, services] of allServices) {
    for (const svc of services) {
      const alias = uniqueName(svc.className)
      const importPath = relativeFromRegistry(registryDir, svc.filePath)
      imports.push(
        `import type { ${svc.className}${alias !== svc.className ? ` as ${alias}` : ""} } from "${importPath}"`,
      )
      const quotedKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(svc.key)
        ? svc.key
        : `"${svc.key}"`
      routerEntries.push(`  ${quotedKey}: ExtractRpcMethods<${alias}>`)
    }
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { CoreServiceRouter } from "@zenbujs/core/registry"`,
    ...imports,
    "",
    `type ServiceBase =\n${SERVICE_BASE_LITERAL}`,
    "",
    "type ExtractRpcMethods<T> = {",
    "  [K in Exclude<keyof T, ServiceBase | `_${string}`> as T[K] extends (",
    "    ...args: any[]",
    "  ) => any",
    "    ? K",
    "    : never]: T[K]",
    "}",
    "",
    "export type PluginServiceRouter = {",
    ...routerEntries.map((e) => e + ";"),
    "}",
    "",
    "export type ServiceRouter = CoreServiceRouter & PluginServiceRouter",
    "",
  ].join("\n")
}

function generatePreloadsFile(
  registryDir: string,
  allPreloads: Map<string, PreloadEntry>,
): string {
  const imports: string[] = []
  const entries: string[] = []
  const usedAliases = new Map<string, number>()
  function uniqueAlias(base: string): string {
    const count = usedAliases.get(base) ?? 0
    usedAliases.set(base, count + 1)
    return count === 0 ? base : `${base}${count}`
  }
  for (const [, { name, preloadPath }] of allPreloads) {
    const camel = name.replace(/(^|[-_])(\w)/g, (_m, _p, c: string) =>
      _p ? c.toUpperCase() : c,
    )
    const alias = uniqueAlias(`${camel}Preload`)
    const importPath = relativeFromRegistry(registryDir, preloadPath)
    imports.push(`import type { default as ${alias} } from "${importPath}"`)
    const quotedName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
      ? name
      : `"${name}"`
    entries.push(`  ${quotedName}: Awaited<ReturnType<typeof ${alias}>>`)
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { CorePreloads } from "@zenbujs/core/registry"`,
    ...imports,
    "",
    "export type PluginPreloads = {",
    ...entries.map((e) => e + ";"),
    "}",
    "",
    "export type Preloads = CorePreloads & PluginPreloads",
    "",
  ].join("\n")
}

function generateEventsFile(
  registryDir: string,
  allEvents: Map<string, EventsEntry>,
): string {
  const imports: string[] = []
  const aliases: string[] = []
  const usedAliases = new Map<string, number>()
  function uniqueAlias(base: string): string {
    const count = usedAliases.get(base) ?? 0
    usedAliases.set(base, count + 1)
    return count === 0 ? base : `${base}${count}`
  }
  for (const [, { name, eventsPath }] of allEvents) {
    const camel = name.replace(/(^|[-_])(\w)/g, (_m, _p, c: string) =>
      _p ? c.toUpperCase() : c,
    )
    const alias = uniqueAlias(`Events_${camel}`)
    const importPath = relativeFromRegistry(registryDir, eventsPath)
    imports.push(`import type { Events as ${alias} } from "${importPath}"`)
    aliases.push(alias)
  }
  // Empty case: PluginEvents is the never-key record. Same shape as
  // zenrpc's `Record<string, never>` default for `TEvents`, so callers
  // that do `EmitProxy<PluginEvents>` get a no-op proxy with no events.
  const body =
    aliases.length === 0
      ? "Record<string, never>"
      : aliases.join(" & ")
  return [
    "// Generated by: zen link",
    "",
    `import type { CoreEvents } from "@zenbujs/core/registry"`,
    ...imports,
    "",
    "/**",
    " * Intersection of every plugin's `Events` type. Plugins extend this",
    " * by declaring `events: \"./path/to/events.ts\"` in their",
    " * zenbu.plugin.json and exporting `export type Events = { ... }` from",
    " * that file. Each plugin chooses its own top-level namespace keys",
    " * (e.g. `pty`, `bottomTerminal`); colliding keys with different payload",
    " * shapes collapse to `never` at use sites — caught at compile time.",
    " */",
    `export type PluginEvents = CoreEvents & ${body}`,
    "",
  ].join("\n")
}

/**
 * Generate the module-augmentation that wires `DbRoot`, `ServiceRouter`,
 * and `PluginEvents` from the user's registry into `@zenbujs/core/react`'s
 * `ZenbuRegister` interface. With this in place the renderer hooks are
 * fully typed without a single generic at the call site.
 */
function generateRegisterFile(): string {
  return [
    "// Generated by: zen link",
    "",
    `import type { DbRoot } from "./db-sections"`,
    `import type { ServiceRouter } from "./services"`,
    `import type { PluginEvents } from "./events"`,
    "",
    `declare module "@zenbujs/core/registry" {`,
    "  interface ZenbuRegister {",
    "    db: DbRoot",
    "    rpc: ServiceRouter",
    "    events: PluginEvents",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function generateDbSectionsFile(
  registryDir: string,
  allSchemas: Map<string, SchemaEntry>,
): string {
  const imports: string[] = []
  const sectionEntries: string[] = []
  const usedAliases = new Map<string, number>()
  function uniqueAlias(base: string): string {
    const count = usedAliases.get(base) ?? 0
    usedAliases.set(base, count + 1)
    return count === 0 ? base : `${base}${count}`
  }
  for (const [, { name, schemaPath }] of allSchemas) {
    const pascal =
      name.replace(/(^|[-_])(\w)/g, (_m, _p, c: string) => c.toUpperCase()) +
      "Root"
    const alias = uniqueAlias(pascal)
    const importPath = relativeFromRegistry(registryDir, schemaPath)
    imports.push(`import type { SchemaRoot as ${alias} } from "${importPath}"`)
    const quotedName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
      ? name
      : `"${name}"`
    sectionEntries.push(`  ${quotedName}: ${alias}`)
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { CoreDbSections } from "@zenbujs/core/registry"`,
    ...imports,
    "",
    "export type PluginDbSections = {",
    ...sectionEntries.map((e) => e + ";"),
    "}",
    "",
    "export type DbSections = CoreDbSections & PluginDbSections",
    "",
    "export type DbRoot = { plugin: DbSections }",
    "",
  ].join("\n")
}

function readExistingRegistry(registryDir: string): {
  services: Map<string, ServiceEntry[]>
  schemas: Map<string, SchemaEntry>
  preloads: Map<string, PreloadEntry>
  events: Map<string, EventsEntry>
} {
  const services = new Map<string, ServiceEntry[]>()
  const schemas = new Map<string, SchemaEntry>()
  const preloads = new Map<string, PreloadEntry>()
  const events = new Map<string, EventsEntry>()

  const servicesPath = path.join(registryDir, "services.ts")
  if (fs.existsSync(servicesPath)) {
    const content = fs.readFileSync(servicesPath, "utf8")
    const importRe = /import type \{ (\w+)(?:\s+as\s+(\w+))? \} from "([^"]+)"/g
    const routerRe = /^\s+(?:"([^"]+)"|(\w+)):\s+ExtractRpcMethods<(\w+)>/gm
    const importMap = new Map<string, { className: string; filePath: string }>()
    for (const m of content.matchAll(importRe)) {
      const className = m[1]!
      const alias = m[2] ?? m[1]!
      const relPath = m[3]!
      const absPath = path.resolve(registryDir, relPath) + ".ts"
      importMap.set(alias, { className, filePath: absPath })
    }
    // We don't try to recover plugin ownership from the existing
    // services.ts here — the new link flow always re-runs from the host
    // `zenbu.config.ts`, which is the single source of truth. Anything in
    // `existing.services` that isn't re-asserted by `linkResolvedPlugin`
    // gets dropped on write. The map is kept around (vs. dropping the
    // whole branch) so future incremental link strategies have a starting
    // point.
    void importMap
    void routerRe
  }

  const dbPath = path.join(registryDir, "db-sections.ts")
  if (fs.existsSync(dbPath)) {
    const content = fs.readFileSync(dbPath, "utf8")
    const importRe = /import type \{ SchemaRoot as (\w+) \} from "([^"]+)"/g
    const sectionRe = /^\s+(?:"([^"]+)"|(\w+)):\s+(\w+)/gm
    const importMap = new Map<string, string>()
    for (const m of content.matchAll(importRe)) {
      const alias = m[1]!
      const relPath = m[2]!
      importMap.set(alias, path.resolve(registryDir, relPath) + ".ts")
    }
    for (const m of content.matchAll(sectionRe)) {
      const name = (m[1] ?? m[2])!
      const alias = m[3]!
      const schemaPath = importMap.get(alias)
      if (schemaPath) schemas.set(name, { name, schemaPath })
    }
  }
  const preloadsPath = path.join(registryDir, "preloads.ts")
  if (fs.existsSync(preloadsPath)) {
    const content = fs.readFileSync(preloadsPath, "utf8")
    const importRe = /import type \{ default as (\w+) \} from "([^"]+)"/g
    const entryRe = /^\s+(?:"([^"]+)"|(\w+)):\s+Awaited<ReturnType<typeof (\w+)>>/gm
    const importMap = new Map<string, string>()
    for (const m of content.matchAll(importRe)) {
      const alias = m[1]!
      const relPath = m[2]!
      importMap.set(alias, path.resolve(registryDir, relPath) + ".ts")
    }
    for (const m of content.matchAll(entryRe)) {
      const name = (m[1] ?? m[2])!
      const alias = m[3]!
      const preloadPath = importMap.get(alias)
      if (preloadPath) preloads.set(name, { name, preloadPath })
    }
  }

  // Events ownership recovery would also have walked for zenbu.plugin.json.
  // Same rationale as `services` above: the new flow re-asserts the full set
  // from zenbu.config.ts, so we don't need to reverse-engineer the existing
  // file's contents.
  return { services, schemas, preloads, events }
}

function parseLinkArgs(argv: string[]): {
  manifestArg: string | null
  typesConfigArg: string | null
  registryOverride: string | null
} {
  let manifestArg: string | null = null
  let typesConfigArg: string | null = null
  let registryOverride: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--registry" && i + 1 < argv.length) registryOverride = argv[++i]!
    else if (arg.startsWith("--registry=")) registryOverride = arg.slice("--registry=".length)
    else if (arg === "--types-config" && i + 1 < argv.length) typesConfigArg = argv[++i]!
    else if (arg.startsWith("--types-config=")) typesConfigArg = arg.slice("--types-config=".length)
    else if (!arg.startsWith("-") && !manifestArg) manifestArg = arg
  }
  return { manifestArg, typesConfigArg, registryOverride }
}

type RegistryState = ReturnType<typeof readExistingRegistry>

/**
 * Variant for path-based plugin sources (a `zenbu.plugin.ts` whose default
 * export is a `definePlugin({...})`). Resolved upstream by `loadConfig` so
 * we just consume the resolved record here.
 */
function linkResolvedPlugin(
  plugin: ResolvedPlugin,
  existing: RegistryState,
  opts: { quiet: boolean },
): void {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg)
  log(`Linking types "${plugin.name}" from ${plugin.dir}`)

  const serviceGlobs = plugin.services.map((abs) =>
    path.relative(plugin.dir, abs).split(path.sep).join("/"),
  )
  const serviceEntries = discoverServices(plugin.dir, serviceGlobs)
  log(`  Found ${serviceEntries.length} service(s)`)

  const schemaEntry: SchemaEntry | null = plugin.schemaPath
    ? { name: plugin.name, schemaPath: plugin.schemaPath }
    : null
  if (schemaEntry) log(`  Schema: ${schemaEntry.schemaPath}`)

  const preloadEntry: PreloadEntry | null = plugin.preloadPath
    ? { name: plugin.name, preloadPath: plugin.preloadPath }
    : null
  if (preloadEntry) log(`  Preload: ${preloadEntry.preloadPath}`)

  const eventsEntry: EventsEntry | null = plugin.eventsPath
    ? { name: plugin.name, eventsPath: plugin.eventsPath }
    : null
  if (eventsEntry) log(`  Events: ${eventsEntry.eventsPath}`)

  existing.services.set(plugin.name, serviceEntries)
  if (schemaEntry) existing.schemas.set(plugin.name, schemaEntry)
  if (preloadEntry) existing.preloads.set(plugin.name, preloadEntry)
  else existing.preloads.delete(plugin.name)
  if (eventsEntry) existing.events.set(plugin.name, eventsEntry)
  else existing.events.delete(plugin.name)
}

/**
 * Variant for the framework-internal `--types-config <path>` flow where the
 * input is a small JSON file (e.g. `packages/core/zenbu-types.config.json`).
 * Used by `pnpm link:types` inside core to bake its own services/registry
 * types without going through a `zenbu.config.ts`.
 */
function linkTypesConfig(
  jsonPath: string,
  existing: RegistryState,
  opts: { quiet: boolean },
): void {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg)
  const manifest = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LinkConfig
  const pluginName = manifest.name
  const baseDir = path.dirname(jsonPath)
  log(`Linking types "${pluginName}" from ${baseDir}`)

  const serviceEntries = discoverServices(baseDir, manifest.services ?? [])
  log(`  Found ${serviceEntries.length} service(s)`)

  const schemaEntry: SchemaEntry | null = manifest.schema
    ? { name: pluginName, schemaPath: path.resolve(baseDir, manifest.schema) }
    : null
  if (schemaEntry) log(`  Schema: ${schemaEntry.schemaPath}`)

  const preloadEntry: PreloadEntry | null = manifest.preload
    ? { name: pluginName, preloadPath: path.resolve(baseDir, manifest.preload) }
    : null
  if (preloadEntry) log(`  Preload: ${preloadEntry.preloadPath}`)

  const eventsEntry: EventsEntry | null = manifest.events
    ? { name: pluginName, eventsPath: path.resolve(baseDir, manifest.events) }
    : null
  if (eventsEntry) log(`  Events: ${eventsEntry.eventsPath}`)

  existing.services.set(pluginName, serviceEntries)
  if (schemaEntry) existing.schemas.set(pluginName, schemaEntry)
  if (preloadEntry) existing.preloads.set(pluginName, preloadEntry)
  else existing.preloads.delete(pluginName)
  if (eventsEntry) existing.events.set(pluginName, eventsEntry)
  else existing.events.delete(pluginName)
}

/**
 * Per-install bootstrap for a plugin. The plugin ships a portable
 * `tsconfig.json` with no host-specific paths; this writes a sibling
 * `tsconfig.local.json` (gitignored) that wires `#registry/*` to the host
 * app's `types/` so the plugin can `import type {...} from "#registry/foo"`
 * the same way the host does. Idempotent.
 *
 * This is the only mechanism that knows where the host lives — it has to
 * be regenerated whenever the plugin moves between hosts.
 */
/**
 * Generate `<plugin>/tsconfig.local.json` — the BASE config that the
 * plugin's committed `tsconfig.json` extends. This file is gitignored and
 * regenerated by every `zen link` so the host-specific bits (the
 * `#registry/*` path mapping and the registry-augmentation include) move
 * with the plugin's host installation.
 *
 * Why this and not `tsconfig.json` itself: the IDE (VSCode/Cursor) walks
 * up looking for `tsconfig.json` and uses only that one. It never picks up
 * a sibling `tsconfig.local.json` on its own. So we keep `tsconfig.json`
 * as the IDE-discovered, plugin-author-edited entry point and have it
 * `"extends": "./tsconfig.local.json"`. The generated file then carries
 * `paths` + `include`, which TS merges into the IDE's resolved program.
 */
function writePluginTsconfigLocal(
  pluginDir: string,
  registryDir: string,
  opts: { quiet: boolean },
): void {
  const ownTsconfig = path.join(pluginDir, "tsconfig.json")
  if (!fs.existsSync(ownTsconfig)) {
    // No tsconfig → not a TypeScript project; skip silently.
    return
  }
  // Skip the host app. The host owns the registry directory and wires
  // `#registry/*` directly in its primary `tsconfig.json`; a sibling
  // `tsconfig.local.json` would be a redundant second source of truth.
  for (const name of CONFIG_NAMES) {
    if (fs.existsSync(path.join(pluginDir, name))) return
  }
  const target = path.join(pluginDir, "tsconfig.local.json")
  let registryRel = path.relative(pluginDir, registryDir)
  if (!registryRel.startsWith(".")) registryRel = "./" + registryRel
  const body = {
    compilerOptions: {
      paths: {
        "#registry/*": [`${registryRel}/*`],
      },
    },
    // TS's `extends` does NOT merge `include`/`exclude`/`files`; the
    // extending config replaces them entirely. So this base needs to
    // declare *everything* the plugin should typecheck. The committed
    // `tsconfig.json` deliberately omits `include` for that reason.
    include: [
      "src",
      // Pulls the central `ZenbuRegister` augmentation (DbRoot,
      // ServiceRouter, PluginEvents) into the plugin's compilation unit
      // so `useDb` / `useRpc` / `useEvents` and `DbService.client` are
      // typed against the merged registry, not core-only fallbacks.
      `${registryRel}/zenbu-register.ts`,
    ],
  }
  const next = JSON.stringify(body, null, 2) + "\n"
  let prev: string | null = null
  try {
    prev = fs.readFileSync(target, "utf8")
  } catch {}
  if (prev === next) return
  fs.writeFileSync(target, next)
  if (!opts.quiet) console.log(`  Wrote ${target}`)
}

export type LinkProjectResult = {
  registryDir: string
  resolvedConfigPath: string
  /**
   * External plugin source files (`zenbu.plugin.ts` paths) that the loader
   * imported to resolve the plugin set. Watchers that want to relink on
   * config edits should treat these as relevant.
   */
  pluginSourceFiles: string[]
  resolved: Awaited<ReturnType<typeof loadConfig>>["resolved"]
}

/**
 * Programmatic variant of `zen link` for the host-project flow. Throws on
 * any error instead of `process.exit`. Used by:
 *   - `runLink` (CLI entry)
 *   - `link-watcher.ts` (file watcher used by `zen dev`)
 *
 * `quiet: true` suppresses the per-step console output the CLI emits — the
 * watcher uses this so the dev terminal stays clean across rapid edits.
 */
export async function linkProject(
  projectDir: string,
  opts: { registryOverride?: string | null; quiet?: boolean } = {},
): Promise<LinkProjectResult> {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg)
  const { resolved, pluginSourceFiles } = await loadConfig(projectDir)

  const registryDir = resolveRegistryDir({
    manifestPath: resolved.configPath,
    manifest: {},
    registryOverride: opts.registryOverride ?? null,
  })
  log(`Registry: ${registryDir}`)

  fs.mkdirSync(registryDir, { recursive: true })
  const existing = readExistingRegistry(registryDir)
  for (const plugin of resolved.plugins) {
    linkResolvedPlugin(plugin, existing, { quiet: !!opts.quiet })
  }

  writeRegistryFiles(registryDir, existing, { quiet: !!opts.quiet })

  // Bootstrap each plugin's per-install tsconfig.local.json so its source
  // can `#registry/*`-import the same types we just wrote. The host app's
  // own dir is skipped (it owns the registry and aliases `#registry/*`
  // directly in its primary tsconfig).
  for (const plugin of resolved.plugins) {
    writePluginTsconfigLocal(plugin.dir, registryDir, { quiet: !!opts.quiet })
  }

  return {
    registryDir,
    resolvedConfigPath: resolved.configPath,
    pluginSourceFiles,
    resolved,
  }
}

export async function runLink(argv: string[]) {
  const { manifestArg, typesConfigArg, registryOverride } = parseLinkArgs(argv)

  // Framework-internal escape hatch: `--types-config <foo.json>` ingests a
  // single small JSON manifest (e.g. core's `zenbu-types.config.json`) and
  // emits registry types for it. Bypasses zenbu.config.ts entirely.
  if (typesConfigArg) {
    const typeConfigPath = path.resolve(typesConfigArg)
    const rootManifest = JSON.parse(fs.readFileSync(typeConfigPath, "utf8")) as LinkConfig
    try {
      const registryDir = resolveRegistryDir({
        manifestPath: typeConfigPath,
        manifest: rootManifest,
        registryOverride,
      })
      console.log(`Registry: ${registryDir}`)
      fs.mkdirSync(registryDir, { recursive: true })
      const existing = readExistingRegistry(registryDir)
      linkTypesConfig(typeConfigPath, existing, { quiet: false })
      writeRegistryFiles(registryDir, existing, { quiet: false })
      console.log("Done.")
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
    return
  }

  // Normal flow: the host project's `zenbu.config.ts` declares the full
  // plugin set. We expand all plugins (host + auxiliary) and link them
  // collectively into the same registry directory.
  const projectDir = manifestArg
    ? path.resolve(manifestArg)
    : findProjectDir(process.cwd())
  if (!projectDir) {
    console.error(
      "zen link: could not find zenbu.config.ts in current directory or any parent.",
    )
    console.error("          For internal framework types, pass --types-config <path>.")
    process.exit(1)
  }

  try {
    await linkProject(projectDir, { registryOverride })
    console.log("Done.")
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

function writeRegistryFiles(
  registryDir: string,
  existing: RegistryState,
  opts: { quiet: boolean },
): void {
  const writes: Array<[string, string]> = [
    ["services.ts", generateServicesFile(registryDir, existing.services)],
    ["db-sections.ts", generateDbSectionsFile(registryDir, existing.schemas)],
    ["preloads.ts", generatePreloadsFile(registryDir, existing.preloads)],
    ["events.ts", generateEventsFile(registryDir, existing.events)],
    ["zenbu-register.ts", generateRegisterFile()],
  ]
  for (const [name, body] of writes) {
    const target = path.join(registryDir, name)
    // Skip writes when content is identical so downstream watchers (Vite,
    // tsc --watch, the IDE) don't see spurious mtime changes that trigger
    // unrelated reloads. Critical for the dev-mode link watcher: it can
    // fire dozens of times during a refactor and most produce no diff.
    let prev: string | null = null
    try { prev = fs.readFileSync(target, "utf8") } catch {}
    if (prev === body) continue
    fs.writeFileSync(target, body)
    if (!opts.quiet) console.log(`  Wrote ${target}`)
  }
}
