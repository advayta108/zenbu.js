import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  loadConfig,
  loadPluginFromPath,
  findConfigPath,
} from "../lib/load-config";
import type {
  ResolvedConfig,
  ResolvedPlugin,
  ResolvedPluginDependency,
} from "../lib/build-config";

// ================================================================
// Layout (v2)
//
//   <plugin>/types/
//     own/
//       services.ts        // SelfServiceMap (this plugin's services only)
//       db-sections.ts     // SelfDbSection
//       events.ts          // SelfEvents
//       preloads.ts        // SelfPreload
//       index.ts           // export type Own = { services; db; events; preloads }
//     deps/<other>/        // vendored copy of upstream's own surface + the
//                          // source files those imports point at
//       own/{services,db-sections,events,preloads,index}.ts
//       <upstream-relative-source-paths>/...
//       .zenbu-vendored.json
//     zenbu-register.ts    // composite — augments @zenbujs/core/registry
//
// All committed; no gitignored shim. Composites import only the local `./own`
// and `./deps/<other>/own` indices, never another plugin's composite, so the
// graph is a strict DAG even with mutual `dependsOn`.
// ================================================================

const SERVICE_BASE_LITERAL = [
  `  | "evaluate"`,
  `  | "shutdown"`,
  `  | "constructor"`,
  `  | "effect"`,
  `  | "__cleanupAllEffects"`,
  `  | "__effectCleanups"`,
  `  | "ctx"`,
].join("\n");

const EXTRACT_RPC_DECL = [
  "type ExtractRpcMethods<T> = {",
  "  [K in Exclude<keyof T, ServiceBase | `_${string}`> as T[K] extends (",
  "    ...args: any[]",
  "  ) => any",
  "    ? K",
  "    : never]: T[K]",
  "}",
].join("\n");

type ServiceEntry = { className: string; key: string; filePath: string };

interface OwnSurface {
  plugin: ResolvedPlugin;
  services: ServiceEntry[];
  schemaPath?: string;
  eventsPath?: string;
  preloadPath?: string;
}

interface WriteOpts {
  quiet: boolean;
}

// =============================================================================
//                                Discovery
// =============================================================================

function expandGlob(baseDir: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    const full = path.resolve(baseDir, pattern);
    return fs.existsSync(full) ? [full] : [];
  }
  const dir = path.resolve(baseDir, path.dirname(pattern));
  const filePattern = path.basename(pattern);
  const regex = new RegExp(
    "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => regex.test(f))
      .map((f) => path.resolve(dir, f));
  } catch {
    return [];
  }
}

const SERVICE_CLASS_KEY_RE =
  /export\s+class\s+(\w+)\s+extends\s+Service\.create\s*\(\s*\{[\s\S]*?\bkey\s*:\s*["']([^"']+)["']/;

function discoverServices(
  baseDir: string,
  serviceGlobs: string[],
): ServiceEntry[] {
  const entries: ServiceEntry[] = [];
  for (const glob of serviceGlobs) {
    for (const filePath of expandGlob(baseDir, glob)) {
      const content = fs.readFileSync(filePath, "utf8");
      const match = content.match(SERVICE_CLASS_KEY_RE);
      if (match) {
        entries.push({
          className: match[1]!,
          key: match[2]!,
          filePath,
        });
      }
    }
  }
  return entries;
}

function discoverOwnSurface(plugin: ResolvedPlugin): OwnSurface {
  const serviceGlobs = plugin.services.map((abs) =>
    path.relative(plugin.dir, abs).split(path.sep).join("/"),
  );
  return {
    plugin,
    services: discoverServices(plugin.dir, serviceGlobs),
    schemaPath: plugin.schemaPath,
    eventsPath: plugin.eventsPath,
    preloadPath: plugin.preloadPath,
  };
}

// =============================================================================
//                                Helpers
// =============================================================================

function relImport(from: string, to: string): string {
  let r = path.relative(from, to).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return r.replace(/\.ts$/, "");
}

function quoteKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : `"${name}"`;
}

function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

function sha256(buf: Buffer | string): string {
  const h = crypto.createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function writeIfChanged(
  target: string,
  body: string,
  opts: WriteOpts,
  label?: string,
): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let prev: string | null = null;
  try {
    prev = fs.readFileSync(target, "utf8");
  } catch {
    /* missing — we'll write */
  }
  if (prev === body) return false;
  fs.writeFileSync(target, body);
  if (!opts.quiet) console.log(`  ${label ?? "Wrote"} ${target}`);
  return true;
}

function writeBufferIfChanged(
  target: string,
  body: Buffer,
  opts: WriteOpts,
): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let prev: Buffer | null = null;
  try {
    prev = fs.readFileSync(target);
  } catch {}
  if (prev && prev.equals(body)) return false;
  fs.writeFileSync(target, body);
  if (!opts.quiet) console.log(`  Wrote ${target}`);
  return true;
}

/** Recursively delete files in `rootDir` that aren't in `expected` (POSIX paths). */
function pruneStale(
  rootDir: string,
  expected: Set<string>,
  opts: WriteOpts,
): void {
  if (!fs.existsSync(rootDir)) return;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path
        .relative(rootDir, full)
        .split(path.sep)
        .join("/");
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {}
      } else if (!expected.has(rel)) {
        try {
          fs.rmSync(full);
          if (!opts.quiet) console.log(`  Pruned ${full}`);
        } catch {}
      }
    }
  };
  walk(rootDir);
}

/** jsonc-lite: strips // and /* * / comments and trailing commas. */
function readJsonLoose(raw: string): any {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

// =============================================================================
//                          Own surface generation
// =============================================================================

function generateOwnServicesFile(
  ownDir: string,
  surface: OwnSurface,
): string {
  const imports: string[] = [];
  const usedNames = new Map<string, number>();
  const lines: string[] = [];
  const uniqueName = (base: string): string => {
    const count = usedNames.get(base) ?? 0;
    usedNames.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  };
  for (const svc of surface.services) {
    const alias = uniqueName(svc.className);
    imports.push(
      `import type { ${svc.className}${
        alias !== svc.className ? ` as ${alias}` : ""
      } } from "${relImport(ownDir, svc.filePath)}"`,
    );
    lines.push(`  ${quoteKey(svc.key)}: ExtractRpcMethods<${alias}>;`);
  }
  return [
    "// Generated by: zen link",
    "// DO NOT EDIT. Plugin's own service surface (no other plugins, no core).",
    "",
    ...imports,
    "",
    `type ServiceBase =\n${SERVICE_BASE_LITERAL}`,
    "",
    EXTRACT_RPC_DECL,
    "",
    "export type SelfServiceMap = {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

function generateOwnDbFile(ownDir: string, surface: OwnSurface): string {
  if (!surface.schemaPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfDbSection = {}",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { InferSchemaRoot } from "@zenbujs/core/db"`,
    `import type schema from "${relImport(ownDir, surface.schemaPath)}"`,
    "",
    "export type SelfDbSection = InferSchemaRoot<typeof schema>",
    "",
  ].join("\n");
}

function generateOwnEventsFile(
  ownDir: string,
  surface: OwnSurface,
): string {
  if (!surface.eventsPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfEvents = {}",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { Events } from "${relImport(ownDir, surface.eventsPath)}"`,
    "",
    "export type SelfEvents = Events",
    "",
  ].join("\n");
}

function generateOwnPreloadsFile(
  ownDir: string,
  surface: OwnSurface,
): string {
  if (!surface.preloadPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfPreload = unknown",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { default as preload } from "${relImport(
      ownDir,
      surface.preloadPath,
    )}"`,
    "",
    "export type SelfPreload = Awaited<ReturnType<typeof preload>>",
    "",
  ].join("\n");
}

function generateOwnIndexFile(): string {
  return [
    "// Generated by: zen link",
    "",
    `import type { SelfServiceMap } from "./services"`,
    `import type { SelfDbSection } from "./db-sections"`,
    `import type { SelfEvents } from "./events"`,
    `import type { SelfPreload } from "./preloads"`,
    "",
    "export type Own = {",
    "  services: SelfServiceMap",
    "  db: SelfDbSection",
    "  events: SelfEvents",
    "  preloads: SelfPreload",
    "}",
    "",
  ].join("\n");
}

function writeOwnSurface(
  ownDir: string,
  surface: OwnSurface,
  opts: WriteOpts,
): void {
  fs.mkdirSync(ownDir, { recursive: true });
  writeIfChanged(
    path.join(ownDir, "services.ts"),
    generateOwnServicesFile(ownDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(ownDir, "db-sections.ts"),
    generateOwnDbFile(ownDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(ownDir, "events.ts"),
    generateOwnEventsFile(ownDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(ownDir, "preloads.ts"),
    generateOwnPreloadsFile(ownDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(ownDir, "index.ts"),
    generateOwnIndexFile(),
    opts,
  );
}

// =============================================================================
//                          Vendored deps (copy upstream)
// =============================================================================

interface VendorSpec {
  /** Absolute path to copy from (in upstream's tree). */
  from: string;
  /** Relative path inside the deps/<name>/ tree. POSIX-style. */
  to: string;
}

function planVendorFiles(
  upstream: ResolvedPlugin,
  surface: OwnSurface,
): VendorSpec[] {
  const out: VendorSpec[] = [];
  const seen = new Set<string>();
  const push = (abs: string): void => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const rel = path
      .relative(upstream.dir, abs)
      .split(path.sep)
      .join("/");
    if (rel.startsWith("..")) {
      throw new Error(
        `zen link: refusing to vendor "${rel}" — file ${abs} is outside upstream plugin dir ${upstream.dir}.`,
      );
    }
    out.push({ from: abs, to: rel });
  };
  for (const svc of surface.services) push(svc.filePath);
  if (surface.schemaPath) push(surface.schemaPath);
  if (surface.eventsPath) push(surface.eventsPath);
  if (surface.preloadPath) push(surface.preloadPath);
  return out;
}

interface VendoredDepResult {
  /** Absolute path to the vendored deps/<name>/ folder. */
  depDir: string;
  /** Relative POSIX path from `consumerDir/types/zenbu-register.ts` to the dep's own/ index. */
  ownImportFromComposite: string;
}

function vendorDepInto(args: {
  consumerDir: string;
  depName: string;
  upstream: ResolvedPlugin;
  manifestFromAbs: string | null;
  opts: WriteOpts;
  driftCheckOnly: boolean;
}): VendoredDepResult {
  const { consumerDir, depName, upstream, opts, driftCheckOnly } = args;
  const surface = discoverOwnSurface(upstream);
  const depDir = path.join(consumerDir, "types", "deps", depName);
  fs.mkdirSync(depDir, { recursive: true });

  const planned = planVendorFiles(upstream, surface);
  const expected = new Set<string>();
  expected.add(".zenbu-vendored.json");
  for (const o of [
    "services.ts",
    "db-sections.ts",
    "events.ts",
    "preloads.ts",
    "index.ts",
  ]) {
    expected.add(`own/${o}`);
  }

  const driftReport: string[] = [];
  const fileHashes: Record<string, string> = {};
  for (const f of planned) {
    expected.add(f.to);
    const target = path.join(depDir, f.to);
    const content = fs.readFileSync(f.from);
    const newHash = sha256(content);
    fileHashes[f.to] = newHash;
    if (driftCheckOnly) {
      let prev: Buffer | null = null;
      try {
        prev = fs.readFileSync(target);
      } catch {}
      if (!prev || sha256(prev) !== newHash) {
        driftReport.push(
          `  drift: ${path.relative(args.consumerDir, target)}`,
        );
      }
      continue;
    }
    writeBufferIfChanged(target, content, opts);
  }

  // Synthesize a vendored own/ surface that imports from the COPIED files.
  const vendoredOwnDir = path.join(depDir, "own");
  const remappedSurface: OwnSurface = {
    plugin: upstream,
    services: surface.services.map((svc) => ({
      ...svc,
      filePath: path.join(
        depDir,
        path.relative(upstream.dir, svc.filePath),
      ),
    })),
    schemaPath: surface.schemaPath
      ? path.join(depDir, path.relative(upstream.dir, surface.schemaPath))
      : undefined,
    eventsPath: surface.eventsPath
      ? path.join(depDir, path.relative(upstream.dir, surface.eventsPath))
      : undefined,
    preloadPath: surface.preloadPath
      ? path.join(depDir, path.relative(upstream.dir, surface.preloadPath))
      : undefined,
  };
  if (!driftCheckOnly) {
    writeOwnSurface(vendoredOwnDir, remappedSurface, opts);
  }

  // Drift manifest. `from` is recorded relative to the dep dir for stable
  // diffs across host moves. Hashes track the actual vendored files.
  const manifest = {
    name: depName,
    upstream:
      args.manifestFromAbs == null
        ? null
        : {
            from: path
              .relative(depDir, args.manifestFromAbs)
              .split(path.sep)
              .join("/"),
          },
    files: fileHashes,
    linkedAt: new Date().toISOString(),
  };
  const manifestBody = JSON.stringify(manifest, null, 2) + "\n";
  if (!driftCheckOnly) {
    // Don't bump linkedAt unless something else changed. Read the existing
    // manifest, swap linkedAt for comparison, and only write if the
    // content-bearing fields differ.
    const manifestPath = path.join(depDir, ".zenbu-vendored.json");
    let prevSemantic: any = null;
    try {
      prevSemantic = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      delete prevSemantic.linkedAt;
    } catch {}
    const nextSemantic: any = JSON.parse(manifestBody);
    delete nextSemantic.linkedAt;
    if (
      prevSemantic &&
      JSON.stringify(prevSemantic) === JSON.stringify(nextSemantic)
    ) {
      // No semantic change; skip the write so mtimes stay quiet.
    } else {
      fs.writeFileSync(manifestPath, manifestBody);
      if (!opts.quiet) console.log(`  Wrote ${manifestPath}`);
    }
    pruneStale(depDir, expected, opts);
  } else if (driftReport.length > 0) {
    throw new Error(
      [
        `zen link --check: vendored copies under ${depDir} are stale relative to upstream.`,
        ...driftReport,
        "  (run \`zen link\` to refresh.)",
      ].join("\n"),
    );
  }

  return {
    depDir,
    ownImportFromComposite: relImport(
      path.join(consumerDir, "types"),
      path.join(vendoredOwnDir, "index.ts"),
    ),
  };
}

// =============================================================================
//                          Composite generation
// =============================================================================

interface CompositeDep {
  name: string;
  ownImport: string;
}

function generateCompositeFile(args: {
  selfName: string | null;
  selfOwnImport: string | null;
  deps: CompositeDep[];
}): string {
  const lines: string[] = [
    "// Generated by: zen link",
    "// DO NOT EDIT. Composite augmentation (own + vendored deps) for this plugin.",
    "",
    `import type {} from "@zenbujs/core/registry"`,
    `import type { CoreServiceRouter, CoreEvents, CoreDbSections } from "@zenbujs/core/registry-generated"`,
  ];
  if (args.selfName && args.selfOwnImport) {
    lines.push(
      `import type { Own as Self_${sanitizeIdent(args.selfName)} } from "${args.selfOwnImport}"`,
    );
  }
  for (const d of args.deps) {
    lines.push(
      `import type { Own as Dep_${sanitizeIdent(d.name)} } from "${d.ownImport}"`,
    );
  }
  lines.push("");

  const rpcEntries: string[] = [];
  const evtEntries: string[] = [];
  const dbEntries: string[] = [];
  if (args.selfName && args.selfOwnImport) {
    const k = quoteKey(args.selfName);
    const a = sanitizeIdent(args.selfName);
    rpcEntries.push(`      ${k}: Self_${a}["services"];`);
    evtEntries.push(`      ${k}: Self_${a}["events"];`);
    dbEntries.push(`      ${k}: Self_${a}["db"];`);
  }
  for (const d of args.deps) {
    const k = quoteKey(d.name);
    const a = sanitizeIdent(d.name);
    rpcEntries.push(`      ${k}: Dep_${a}["services"];`);
    evtEntries.push(`      ${k}: Dep_${a}["events"];`);
    dbEntries.push(`      ${k}: Dep_${a}["db"];`);
  }

  lines.push(`declare module "@zenbujs/core/registry" {`);
  lines.push(`  interface ZenbuRegister {`);
  lines.push(`    rpc: CoreServiceRouter & {`);
  if (rpcEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...rpcEntries);
  lines.push(`    };`);
  lines.push(`    events: CoreEvents & {`);
  if (evtEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...evtEntries);
  lines.push(`    };`);
  lines.push(`    db: CoreDbSections & {`);
  if (dbEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...dbEntries);
  lines.push(`    };`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");
  lines.push("export {}");
  lines.push("");
  return lines.join("\n");
}

// =============================================================================
//                          tsconfig.json bootstrap
// =============================================================================

const REGISTER_INCLUDE = "./types/zenbu-register.ts";

function bootstrapTsconfigJson(pluginDir: string, opts: WriteOpts): void {
  const tsconfigPath = path.join(pluginDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return;
  const raw = fs.readFileSync(tsconfigPath, "utf8");
  let parsed: Record<string, any>;
  try {
    parsed = readJsonLoose(raw);
  } catch {
    return;
  }
  let mutated = false;

  // Drop the legacy v1 escape-hatch shim. The plugin used to extend a
  // gitignored tsconfig.local.json that injected `#registry/*` + a host
  // include; v2 wires the plugin's own composite directly here so the
  // gitignored shim is now redundant.
  if (parsed.extends === "./tsconfig.local.json") {
    delete parsed.extends;
    mutated = true;
  }

  // Drop the `#registry/*` path mapping if present — the new model never
  // resolves anything through it.
  const co = parsed.compilerOptions;
  if (co && typeof co === "object" && co.paths && typeof co.paths === "object") {
    if (co.paths["#registry/*"]) {
      delete co.paths["#registry/*"];
      if (Object.keys(co.paths).length === 0) delete co.paths;
      mutated = true;
    }
  }

  const include: unknown = parsed.include;
  const includeArr: string[] = Array.isArray(include) ? [...include] : [];
  // Already covered by any of: explicit register file, `types`, `./types`,
  // `types/**` glob, or `./types/zenbu-register.ts` exact match.
  const alreadyCovers = includeArr.some(
    (s) =>
      typeof s === "string" &&
      (s === REGISTER_INCLUDE ||
        s === "types" ||
        s === "./types" ||
        s === "types/**" ||
        s === "types/**/*"),
  );
  if (!alreadyCovers) {
    includeArr.push(REGISTER_INCLUDE);
    parsed.include = includeArr;
    mutated = true;
  } else if (!Array.isArray(include)) {
    parsed.include = includeArr;
    mutated = true;
  }

  if (!mutated) return;
  const next = JSON.stringify(parsed, null, 2) + "\n";
  if (next === raw) return;
  fs.writeFileSync(tsconfigPath, next);
  if (!opts.quiet) console.log(`  Updated ${tsconfigPath}`);

  // Sweep the legacy file; it's no longer consulted.
  const legacy = path.join(pluginDir, "tsconfig.local.json");
  if (fs.existsSync(legacy)) {
    try {
      fs.rmSync(legacy);
      if (!opts.quiet) console.log(`  Removed legacy ${legacy}`);
    } catch {}
  }
}

// =============================================================================
//                          --types-config (core's self-link)
// =============================================================================

type LinkConfig = {
  name: string;
  services?: string[];
  schema?: string;
  preload?: string;
  events?: string;
};

/**
 * Generator: `<core>/src/registry-generated.ts` — the publishable
 * type surface that downstream apps' composite registries import via
 * `@zenbujs/core/registry-generated`.
 *
 * Plugins still depend on `CoreServiceRouter` / `CoreEvents` /
 * `CoreDbSections` as stable, namespaced exports, so this surface
 * keeps the v1 shape (it predates the per-plugin own/ layout). v2's
 * uniformity benefit only matters for user plugins, where every
 * plugin author can re-link without touching core.
 */
function generateCoreSurfaceFile(args: {
  services: ServiceEntry[];
  hasEvents: boolean;
  hasSchema: boolean;
}): string {
  const sorted = [...args.services].sort((a, b) =>
    a.className.localeCompare(b.className),
  );
  const importedNames = sorted.map((s) => `  ${s.className},`).join("\n");
  const routerEntries = sorted
    .map((s) => `    ${quoteKey(s.key)}: ExtractRpcMethods<${s.className}>;`)
    .join("\n");
  const lines: string[] = [
    "// Generated by: pnpm link:types",
    "// DO NOT EDIT. Regenerated automatically (also wired into `prebuild`).",
    "",
  ];
  if (sorted.length > 0) {
    lines.push("import type {");
    lines.push(importedNames);
    lines.push(`} from "@zenbujs/core/services"`);
  }
  if (args.hasEvents) {
    lines.push(
      `import type { Events as Events_core } from "@zenbujs/core/events"`,
    );
  }
  if (args.hasSchema) {
    lines.push(`import type schema_core from "@zenbujs/core/schema"`);
    lines.push(`import type { InferSchemaRoot } from "@zenbujs/core/db"`);
  }
  lines.push("");
  lines.push(`type ServiceBase =\n${SERVICE_BASE_LITERAL}`);
  lines.push("");
  lines.push(EXTRACT_RPC_DECL);
  lines.push("");
  lines.push("export type CoreServiceRouter = {");
  lines.push("  core: {");
  if (routerEntries.length > 0) lines.push(routerEntries);
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push(
    `export type CoreEvents = { core: ${args.hasEvents ? "Events_core" : "{}"} }`,
  );
  lines.push("");
  lines.push("export type CoreDbSections = {");
  if (args.hasSchema)
    lines.push("  core: InferSchemaRoot<typeof schema_core>;");
  lines.push("}");
  lines.push("");
  lines.push("export type CorePreloads = {}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Generator: `<core>/types/zenbu-register.ts` — local-only
 * augmentation that drives core's own typecheck. NOT in
 * `package.json#files`; never reaches downstream consumers.
 */
function generateCoreAugmentFile(): string {
  return [
    "// Generated by: pnpm link:types",
    "// DO NOT EDIT. Local-only augmentation (NOT shipped via package.json#files).",
    "// Drives core's own typecheck so useRpc()/useEvents()/useDb() resolve",
    "// to the registered surface inside packages/core/src/.",
    "",
    `import type {} from "@zenbujs/core/registry"`,
    `import type {`,
    `  CoreServiceRouter,`,
    `  CoreEvents,`,
    `  CoreDbSections,`,
    `} from "../src/registry-generated"`,
    "",
    `declare module "@zenbujs/core/registry" {`,
    "  interface ZenbuRegister {",
    "    rpc: CoreServiceRouter",
    "    events: CoreEvents",
    "    db: CoreDbSections",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n");
}

function writeCoreSurfaceFiles(args: {
  services: ServiceEntry[];
  hasEvents: boolean;
  hasSchema: boolean;
  surfaceOut: string;
  augmentOut: string;
  ownDir: string | null;
  ownSurface: OwnSurface | null;
  opts: WriteOpts;
}): void {
  writeIfChanged(
    args.surfaceOut,
    generateCoreSurfaceFile({
      services: args.services,
      hasEvents: args.hasEvents,
      hasSchema: args.hasSchema,
    }),
    args.opts,
  );
  writeIfChanged(args.augmentOut, generateCoreAugmentFile(), args.opts);
  // Mirror v2's per-plugin layout for core itself: emit `core/types/own/*`
  // alongside the legacy registry-generated.ts. Downstream plugins don't
  // import from this path (they import the namespaced Core* exports), but
  // core's own tooling and tests can use it for uniformity.
  if (args.ownDir && args.ownSurface) {
    writeOwnSurface(args.ownDir, args.ownSurface, args.opts);
  }
}

// =============================================================================
//                                Argv parsing
// =============================================================================

function parseLinkArgs(argv: string[]): {
  manifestArg: string | null;
  typesConfigArg: string | null;
  surfaceOutArg: string | null;
  augmentOutArg: string | null;
  ownOutArg: string | null;
  check: boolean;
} {
  let manifestArg: string | null = null;
  let typesConfigArg: string | null = null;
  let surfaceOutArg: string | null = null;
  let augmentOutArg: string | null = null;
  let ownOutArg: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--types-config" && i + 1 < argv.length)
      typesConfigArg = argv[++i]!;
    else if (arg.startsWith("--types-config="))
      typesConfigArg = arg.slice("--types-config=".length);
    else if (arg === "--out" && i + 1 < argv.length) surfaceOutArg = argv[++i]!;
    else if (arg.startsWith("--out="))
      surfaceOutArg = arg.slice("--out=".length);
    else if (arg === "--augment-out" && i + 1 < argv.length)
      augmentOutArg = argv[++i]!;
    else if (arg.startsWith("--augment-out="))
      augmentOutArg = arg.slice("--augment-out=".length);
    else if (arg === "--own-out" && i + 1 < argv.length)
      ownOutArg = argv[++i]!;
    else if (arg.startsWith("--own-out="))
      ownOutArg = arg.slice("--own-out=".length);
    else if (arg === "--check") check = true;
    else if (!arg.startsWith("-") && !manifestArg) manifestArg = arg;
  }
  return {
    manifestArg,
    typesConfigArg,
    surfaceOutArg,
    augmentOutArg,
    ownOutArg,
    check,
  };
}

// =============================================================================
//                                linkProject
// =============================================================================

export type LinkProjectResult = {
  /** Legacy field. Points at the host's primary types directory. */
  registryDir: string;
  resolvedConfigPath: string;
  pluginSourceFiles: string[];
  resolved: ResolvedConfig;
};

export interface LinkProjectOpts {
  quiet?: boolean;
  /** Throw if any vendored copy is stale relative to its upstream. */
  check?: boolean;
}

/**
 * Programmatic entrypoint. Used by:
 *   - `runLink` (CLI)
 *   - `link-watcher.ts` (file watcher used by `zen dev`)
 */
export async function linkProject(
  projectDir: string,
  opts: LinkProjectOpts = {},
): Promise<LinkProjectResult> {
  const writeOpts: WriteOpts = { quiet: !!opts.quiet };
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  const { resolved, pluginSourceFiles } = await loadConfig(projectDir);

  // Sanity: the host (zenbu.config.ts dir) is shared by at most one inline
  // plugin. If multiple inline plugins claim the same `dir`, their generated
  // own/ surfaces would collide. This is a config-level mistake.
  const inlinePlugins = resolved.plugins.filter(
    (p) => p.dir === resolved.projectDir,
  );
  if (inlinePlugins.length > 1) {
    throw new Error(
      `zen link: ${resolved.configPath} declares ${inlinePlugins.length} inline plugins ` +
        `(${inlinePlugins.map((p) => `"${p.name}"`).join(", ")}). ` +
        `Move all but one into separate zenbu.plugin.ts files so each owns its own types/ dir.`,
    );
  }

  // 1) Per-plugin own surface.
  for (const plugin of resolved.plugins) {
    const surface = discoverOwnSurface(plugin);
    log(`Linking own surface "${plugin.name}" at ${plugin.dir}`);
    log(`  ${surface.services.length} service(s)`);
    if (surface.schemaPath) log(`  schema: ${surface.schemaPath}`);
    if (surface.eventsPath) log(`  events: ${surface.eventsPath}`);
    if (surface.preloadPath) log(`  preload: ${surface.preloadPath}`);
    writeOwnSurface(path.join(plugin.dir, "types/own"), surface, writeOpts);
  }

  // 2) Vendor deps.
  // Each plugin gets the subset its `dependsOn` declares. The host inline
  // plugin (if any) gets every other plugin in the resolved set vendored
  // implicitly — its composite needs to cover the runtime plugin set even
  // though the user didn't write a `dependsOn` for it.
  type Vendored = { depName: string; result: VendoredDepResult };
  const perPluginVendored = new Map<ResolvedPlugin, Vendored[]>();

  for (const plugin of resolved.plugins) {
    const vendored: Vendored[] = [];
    const isHost = plugin.dir === resolved.projectDir;
    if (isHost) {
      for (const other of resolved.plugins) {
        if (other === plugin) continue;
        log(`Vendoring "${other.name}" into host "${plugin.name}"`);
        vendored.push({
          depName: other.name,
          result: vendorDepInto({
            consumerDir: plugin.dir,
            depName: other.name,
            upstream: other,
            manifestFromAbs: null,
            opts: writeOpts,
            driftCheckOnly: !!opts.check,
          }),
        });
      }
    } else {
      for (const dep of plugin.dependsOn ?? []) {
        const upstream = await loadPluginFromPath({
          fromPath: dep.fromPath,
          name: dep.name,
        });
        log(`Vendoring "${dep.name}" into "${plugin.name}"`);
        vendored.push({
          depName: dep.name,
          result: vendorDepInto({
            consumerDir: plugin.dir,
            depName: dep.name,
            upstream,
            manifestFromAbs: dep.fromPath,
            opts: writeOpts,
            driftCheckOnly: !!opts.check,
          }),
        });
      }
    }
    perPluginVendored.set(plugin, vendored);

    // Stale dep dirs: prune any deps/<name>/ folder that's no longer in the
    // current dependsOn (or, for the host, no longer in plugins:[]).
    const wantedDepNames = new Set(vendored.map((v) => v.depName));
    const depsRoot = path.join(plugin.dir, "types/deps");
    if (fs.existsSync(depsRoot)) {
      for (const entry of fs.readdirSync(depsRoot)) {
        if (wantedDepNames.has(entry)) continue;
        const stale = path.join(depsRoot, entry);
        try {
          fs.rmSync(stale, { recursive: true, force: true });
          if (!writeOpts.quiet) console.log(`  Pruned ${stale}`);
        } catch {}
      }
    }
  }

  // 3) Composite per plugin.
  for (const plugin of resolved.plugins) {
    const compositePath = path.join(plugin.dir, "types/zenbu-register.ts");
    const compositeDir = path.dirname(compositePath);
    const selfOwnImport = relImport(
      compositeDir,
      path.join(plugin.dir, "types/own/index.ts"),
    );
    const vendored = perPluginVendored.get(plugin) ?? [];
    const deps: CompositeDep[] = vendored.map((v) => ({
      name: v.depName,
      ownImport: relImport(
        compositeDir,
        path.join(v.result.depDir, "own/index.ts"),
      ),
    }));
    const body = generateCompositeFile({
      selfName: plugin.name,
      selfOwnImport,
      deps,
    });
    if (!opts.check) writeIfChanged(compositePath, body, writeOpts);
  }

  // 4) tsconfig.json bootstrap (idempotent).
  if (!opts.check) {
    for (const plugin of resolved.plugins) {
      bootstrapTsconfigJson(plugin.dir, writeOpts);
    }
    if (inlinePlugins.length === 0) {
      bootstrapTsconfigJson(resolved.projectDir, writeOpts);
    }
  }

  return {
    registryDir: path.join(resolved.projectDir, "types"),
    resolvedConfigPath: resolved.configPath,
    pluginSourceFiles,
    resolved,
  };
}

// =============================================================================
//                                CLI entrypoint
// =============================================================================

const CONFIG_NAMES = [
  "zenbu.config.ts",
  "zenbu.config.mts",
  "zenbu.config.js",
  "zenbu.config.mjs",
];

function findProjectDir(from: string): string | null {
  let dir = path.resolve(from);
  while (true) {
    for (const name of CONFIG_NAMES) {
      if (fs.existsSync(path.join(dir, name))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function runLink(argv: string[]) {
  const args = parseLinkArgs(argv);

  // Framework-internal: core's self-link. Bypasses zenbu.config.ts entirely
  // and emits the publishable `registry-generated.ts` + a local-only
  // `zenbu-register.ts` augmentation.
  if (args.typesConfigArg) {
    const typeConfigPath = path.resolve(args.typesConfigArg);
    const rootManifest = JSON.parse(
      fs.readFileSync(typeConfigPath, "utf8"),
    ) as LinkConfig;
    const baseDir = path.dirname(typeConfigPath);
    const surfaceOut = args.surfaceOutArg
      ? path.resolve(args.surfaceOutArg)
      : path.join(baseDir, "src", "registry-generated.ts");
    const augmentOut = args.augmentOutArg
      ? path.resolve(args.augmentOutArg)
      : path.join(baseDir, "types", "zenbu-register.ts");
    const ownOut = args.ownOutArg
      ? path.resolve(args.ownOutArg)
      : path.join(baseDir, "types", "own");

    try {
      console.log(`Linking core types from ${baseDir}`);
      const services = discoverServices(
        baseDir,
        rootManifest.services ?? [],
      );
      console.log(`  Found ${services.length} service(s)`);
      const hasEvents = !!rootManifest.events;
      const hasSchema = !!rootManifest.schema;
      if (rootManifest.events)
        console.log(
          `  Events: ${path.resolve(baseDir, rootManifest.events)}`,
        );
      if (rootManifest.schema)
        console.log(
          `  Schema: ${path.resolve(baseDir, rootManifest.schema)}`,
        );

      // Compose a synthetic ResolvedPlugin so the v2 own-surface generator
      // can write `core/types/own/*` alongside the legacy registry file.
      const corePlugin: ResolvedPlugin = {
        name: rootManifest.name,
        dir: baseDir,
        services: (rootManifest.services ?? []).map((s) =>
          path.resolve(baseDir, s),
        ),
        schemaPath: rootManifest.schema
          ? path.resolve(baseDir, rootManifest.schema)
          : undefined,
        eventsPath: rootManifest.events
          ? path.resolve(baseDir, rootManifest.events)
          : undefined,
        preloadPath: rootManifest.preload
          ? path.resolve(baseDir, rootManifest.preload)
          : undefined,
      };
      const ownSurface: OwnSurface = {
        plugin: corePlugin,
        services,
        schemaPath: corePlugin.schemaPath,
        eventsPath: corePlugin.eventsPath,
        preloadPath: corePlugin.preloadPath,
      };

      writeCoreSurfaceFiles({
        services,
        hasEvents,
        hasSchema,
        surfaceOut,
        augmentOut,
        ownDir: ownOut,
        ownSurface,
        opts: { quiet: false },
      });
      console.log("Done.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  // Default: host project link.
  const projectDir = args.manifestArg
    ? path.resolve(args.manifestArg)
    : findProjectDir(process.cwd());
  if (!projectDir) {
    console.error(
      "zen link: could not find zenbu.config.ts in current directory or any parent.",
    );
    console.error(
      "          For internal framework types, pass --types-config <path>.",
    );
    process.exit(1);
  }

  try {
    // Validate the host has a config before doing any work.
    findConfigPath(projectDir);
    await linkProject(projectDir, { check: args.check });
    console.log("Done.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
