import fs from "node:fs"
import path from "node:path"

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

function findManifest(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    const candidate = path.join(dir, "zenbu.plugin.json")
    if (fs.existsSync(candidate)) return candidate
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
 * An app root is the nearest ancestor (or self) that contains BOTH a
 * `zenbu.plugin.json` and a `config.json` whose `plugins` is an array.
 * That signature distinguishes the app from a bare plugin manifest.
 */
function findAppRoot(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    const manifest = path.join(dir, "zenbu.plugin.json")
    const config = path.join(dir, "config.json")
    if (fs.existsSync(manifest) && fs.existsSync(config)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(config, "utf8"))
        if (Array.isArray(parsed?.plugins)) return dir
      } catch {}
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
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

  console.error(
    `zen link: could not determine target types directory for ${opts.manifestPath}.`,
  )
  console.error(`         Try one of:`)
  console.error(
    `         • run from inside an app dir (with both zenbu.plugin.json and config.json),`,
  )
  console.error(
    `         • add a "devAppPath" field to ${path.basename(opts.manifestPath)} pointing at the host app,`,
  )
  console.error(
    `         • create a tsconfig.local.json with a "#registry/*" path mapping,`,
  )
  console.error(`         • or pass --registry <dir>.`)
  process.exit(1)
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
  for (const glob of serviceGlobs) {
    for (const filePath of expandGlob(baseDir, glob)) {
      const content = fs.readFileSync(filePath, "utf8")
      const classMatch = content.match(/export\s+class\s+(\w+)\s+extends\s+Service/)
      const keyMatch = content.match(/static\s+key\s*=\s*["']([^"']+)["']/)
      if (classMatch && keyMatch) {
        entries.push({
          className: classMatch[1]!,
          key: keyMatch[1]!,
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
    for (const m of content.matchAll(routerRe)) {
      const key = (m[1] ?? m[2])!
      const alias = m[3]!
      const imp = importMap.get(alias)
      if (!imp) continue
      let pluginName: string | null = null
      let dir = path.dirname(imp.filePath)
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "zenbu.plugin.json")
        if (fs.existsSync(candidate)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(candidate, "utf8"))
            pluginName = manifest.name
          } catch {}
          break
        }
        dir = path.dirname(dir)
      }
      if (!pluginName) continue
      if (!services.has(pluginName)) services.set(pluginName, [])
      services.get(pluginName)!.push({
        className: imp.className,
        key,
        filePath: imp.filePath,
      })
    }
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

  // Events: each plugin contributes `import type { Events as Events_<x> }`
  // and joins the `PluginEvents = ...` intersection. Walk back from the
  // import path to the owning plugin's manifest to recover its name —
  // same trick as services.
  const eventsRegistryPath = path.join(registryDir, "events.ts")
  if (fs.existsSync(eventsRegistryPath)) {
    const content = fs.readFileSync(eventsRegistryPath, "utf8")
    const importRe = /import type \{ Events as (\w+) \} from "([^"]+)"/g
    for (const m of content.matchAll(importRe)) {
      const alias = m[1]!
      const relPath = m[2]!
      const eventsPath = path.resolve(registryDir, relPath) + ".ts"
      let pluginName: string | null = null
      let dir = path.dirname(eventsPath)
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "zenbu.plugin.json")
        if (fs.existsSync(candidate)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(candidate, "utf8"))
            pluginName = manifest.name
          } catch {}
          break
        }
        dir = path.dirname(dir)
      }
      if (!pluginName) continue
      events.set(pluginName, { name: pluginName, eventsPath })
      void alias
    }
  }

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

function linkOne(manifestPath: string, existing: RegistryState): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LinkConfig
  const pluginName = manifest.name
  const baseDir = path.dirname(manifestPath)
  console.log(`Linking types "${pluginName}" from ${baseDir}`)

  const serviceEntries = discoverServices(baseDir, manifest.services ?? [])
  console.log(`  Found ${serviceEntries.length} service(s)`)

  const schemaEntry: SchemaEntry | null = manifest.schema
    ? { name: pluginName, schemaPath: path.resolve(baseDir, manifest.schema) }
    : null
  if (schemaEntry) console.log(`  Schema: ${schemaEntry.schemaPath}`)

  const preloadEntry: PreloadEntry | null = manifest.preload
    ? { name: pluginName, preloadPath: path.resolve(baseDir, manifest.preload) }
    : null
  if (preloadEntry) console.log(`  Preload: ${preloadEntry.preloadPath}`)

  const eventsEntry: EventsEntry | null = manifest.events
    ? { name: pluginName, eventsPath: path.resolve(baseDir, manifest.events) }
    : null
  if (eventsEntry) console.log(`  Events: ${eventsEntry.eventsPath}`)

  existing.services.set(pluginName, serviceEntries)
  if (schemaEntry) existing.schemas.set(pluginName, schemaEntry)
  // If a plugin removed its `preload` field, drop it from the merged registry.
  // Otherwise insert/replace with the current entry.
  if (preloadEntry) existing.preloads.set(pluginName, preloadEntry)
  else existing.preloads.delete(pluginName)
  if (eventsEntry) existing.events.set(pluginName, eventsEntry)
  else existing.events.delete(pluginName)
}

/**
 * When the manifest being linked is the host app's own manifest (sitting
 * next to its `config.json`), expand the work list to also include every
 * plugin path declared in `config.json#plugins`. For any other manifest
 * (a plugin sitting inside or outside the app), only that single manifest
 * is returned — the caller decides not to touch sibling plugins.
 */
function expandAppManifests(manifestPath: string): string[] {
  const manifestDir = path.dirname(manifestPath)
  const appRoot = findAppRoot(manifestDir)
  if (appRoot !== manifestDir) return [manifestPath]
  const configPath = path.join(appRoot, "config.json")
  let pluginEntries: string[] = []
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (Array.isArray(config?.plugins)) pluginEntries = config.plugins
  } catch {}
  const all = [manifestPath]
  for (const entry of pluginEntries) {
    const resolved = path.isAbsolute(entry) ? entry : path.resolve(appRoot, entry)
    if (path.resolve(resolved) === path.resolve(manifestPath)) continue
    if (!fs.existsSync(resolved)) {
      console.warn(`  ⚠ skipping ${entry} (not found at ${resolved})`)
      continue
    }
    all.push(resolved)
  }
  return all
}

export async function runLink(argv: string[]) {
  const { manifestArg, typesConfigArg, registryOverride } = parseLinkArgs(argv)
  const typeConfigPath = typesConfigArg ? path.resolve(typesConfigArg) : null
  const manifestPath = typeConfigPath
    ? null
    : manifestArg
      ? path.resolve(manifestArg)
      : findManifest(process.cwd())
  if (!typeConfigPath && !manifestPath) {
    console.error(
      "zen link: could not find zenbu.plugin.json in current directory or any parent.",
    )
    console.error("          For internal framework types, pass --types-config <path>.")
    process.exit(1)
  }

  const rootConfigPath = typeConfigPath ?? manifestPath!
  const rootManifest = JSON.parse(fs.readFileSync(rootConfigPath, "utf8"))

  const registryDir = resolveRegistryDir({
    manifestPath: rootConfigPath,
    manifest: rootManifest,
    registryOverride,
  })
  console.log(`Registry: ${registryDir}`)

  const manifestPaths = typeConfigPath ? [typeConfigPath] : expandAppManifests(manifestPath!)

  fs.mkdirSync(registryDir, { recursive: true })
  const existing = readExistingRegistry(registryDir)
  for (const mp of manifestPaths) {
    linkOne(mp, existing)
  }

  const writes: Array<[string, string]> = [
    ["services.ts", generateServicesFile(registryDir, existing.services)],
    ["db-sections.ts", generateDbSectionsFile(registryDir, existing.schemas)],
    ["preloads.ts", generatePreloadsFile(registryDir, existing.preloads)],
    ["events.ts", generateEventsFile(registryDir, existing.events)],
  ]
  for (const [name, body] of writes) {
    const target = path.join(registryDir, name)
    fs.writeFileSync(target, body)
    console.log(`  Wrote ${target}`)
  }
  console.log("Done.")
}
