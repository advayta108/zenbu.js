import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import type { WebSocket } from "ws";
import { createDb, type Db, type SectionConfig } from "@zenbu/kyju";
import type { KyjuError, EffectFieldNode, FieldNode } from "@zenbu/kyju";
import type * as Effect from "effect/Effect";
import { createRouter, dbStringify, dbParse } from "@zenbu/kyju/transport";
import { loadMigrationsFromDir } from "@zenbu/kyju/loader";
import { Service, runtime } from "../runtime";
import type { ResolvedDbRoot } from "../registry";
import { schema as coreSchema } from "../schema";
import { trace as traceSpan } from "../shared/tracer";
import { addDb, resolveDbPath } from "../shared/db-registry";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";

const log = createLogger("db");

const coreSection: SectionConfig = {
  name: "core",
  schema: coreSchema,
  migrations: [],
};

type EffectSectionProxy<S> = {
  [K in keyof S]: EffectFieldNode<S[K]>;
};

type SectionProxy<S> = {
  [K in keyof S]: FieldNode<S[K]>;
};

// `Root` is the resolved DB root: `ZenbuRegister["db"]` from the user's
// generated `zenbu-register.ts`, falling back to `{ plugin: CoreDbSections }`
// when no plugin has augmented the registry. Lets the same baked dts ship
// with core while consumer types flow in via module augmentation.
type Root = ResolvedDbRoot;
type Plugin = Root extends { plugin: infer P } ? P : never;

export type SectionedEffectClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Effect.Effect<void, KyjuError>;
  createBlob(data: Uint8Array, hot?: boolean): Effect.Effect<string, KyjuError>;
  deleteBlob(blobId: string): Effect.Effect<void, KyjuError>;
  getBlobData(blobId: string): Effect.Effect<Uint8Array | null, KyjuError>;
  plugin: {
    [K in keyof Plugin]: EffectSectionProxy<Plugin[K]>;
  };
};

export type SectionedClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Promise<void>;
  createBlob(data: Uint8Array, hot?: boolean): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
  plugin: {
    [K in keyof Plugin]: SectionProxy<Plugin[K]>;
  };
};

export async function resolveManifestModulePath(
  baseDir: string,
  specifier: string,
): Promise<string> {
  const resolved = path.resolve(baseDir, specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [
        resolved,
        `${resolved}.ts`,
        `${resolved}.js`,
        `${resolved}.mjs`,
        path.join(resolved, "index.ts"),
        path.join(resolved, "index.js"),
        path.join(resolved, "index.mjs"),
      ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() || stat.isDirectory()) return candidate;
    } catch {
      // keep trying candidates
    }
  }

  throw new Error(
    `Could not resolve module entry for "${specifier}" from "${baseDir}"`,
  );
}

async function importFreshModule(modulePath: string): Promise<any> {
  // Plain `import()` so dynohot wraps the schema/migrations as live deps of
  // DbService. When these files change, dynohot's file watcher invalidates
  // them and propagates upward via `iterateWithDynamics`; DbService's
  // `runtime.register(..., import.meta)` accept handler re-runs
  // evaluate(), which re-discovers sections and calls createDb with the new
  // migrations array. Kyju's migration plugin then applies only the delta
  // against the existing on-disk DB.
  return import(pathToFileURL(modulePath).href);
}

async function resolveConfigPath(): Promise<string> {
  if (process.env.ZENBU_CONFIG_PATH) return process.env.ZENBU_CONFIG_PATH;
  const jsonc = path.join(os.homedir(), ".zenbu", "config.jsonc");
  try {
    await fs.access(jsonc);
    return jsonc;
  } catch {
    return path.join(os.homedir(), ".zenbu", "config.json");
  }
}

/**
 * Parse the app's `config.json` (jsonc tolerated) and return the fields
 * `setupGate`/`DbService` care about. `db` is required — `resolveDbPath`
 * later asserts on it; we do the read here so both `discoverSections` and
 * `resolveDbPath` see one parse.
 */
type AppConfig = {
  db: string;
  plugins: string[];
};

async function loadAppConfig(configPath: string): Promise<AppConfig> {
  let raw: unknown;
  try {
    const text = await fs.readFile(configPath, "utf8");
    raw = parseJsonc(text);
  } catch (err) {
    throw new Error(
      `Failed to read Zenbu config at ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`Zenbu config at ${configPath} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const plugins = Array.isArray(obj.plugins)
    ? (obj.plugins.filter((p): p is string => typeof p === "string"))
    : [];
  const db = typeof obj.db === "string" ? obj.db : "";
  return { db, plugins };
}

function parseJsonc(str: string): unknown {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === '"') {
      let j = i + 1;
      while (j < str.length) {
        if (str[j] === "\\") {
          j += 2;
        } else if (str[j] === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      result += str.slice(i, j);
      i = j;
    } else if (str[i] === "/" && str[i + 1] === "/") {
      i += 2;
      while (i < str.length && str[i] !== "\n") i++;
    } else if (str[i] === "/" && str[i + 1] === "*") {
      i += 2;
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }
  return JSON.parse(result.replace(/,\s*([\]}])/g, "$1"));
}

export async function discoverSections(
  configPath?: string,
): Promise<SectionConfig[]> {
  const resolvedConfigPath = configPath ?? (await resolveConfigPath());
  let config: { plugins: string[] } = { plugins: [] };
  try {
    const raw = await fs.readFile(resolvedConfigPath, "utf8");
    config = parseJsonc(raw) as { plugins: string[] };
  } catch (error) {
    log.error(
      `failed to read plugin config at ${resolvedConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  // Per-plugin accounting. Each task fills its own entry; push order doesn't
  // matter because we sort before logging.
  const perPluginTimings: Array<{
    name: string;
    manifestMs: number;
    resolveSchemaMs: number;
    importSchemaMs: number;
    resolveMigrationsMs: number;
    importMigrationsMs: number;
    totalMs: number;
  }> = [];

  // Parallelize two axes:
  //   • Across plugins: all manifests process concurrently (outer Promise.all)
  //   • Within a plugin: schema chain and migrations chain overlap
  //
  // The imports are IO-bound (tsx compile, dynohot wrap, JS evaluation). Node's
  // ESM loader handles concurrent imports safely and the V8 compile cache
  // deduplicates work across overlapping compiles of the same file.
  const tasks = config.plugins.map(
    async (manifestPath): Promise<SectionConfig | null> => {
      const pluginStart = Date.now();
      let manifestMs = 0;
      let resolveSchemaMs = 0;
      let importSchemaMs = 0;
      let resolveMigrationsMs = 0;
      let importMigrationsMs = 0;
      let pluginName = path.basename(path.dirname(manifestPath));

      try {
        const t0 = Date.now();
        const raw = await traceSpan(
          "discover:read-manifest",
          () => fs.readFile(manifestPath, "utf8"),
          { parentKey: "db", meta: { plugin: pluginName } },
        );
        manifestMs = Date.now() - t0;

        const manifest = JSON.parse(raw);
        pluginName = manifest.name ?? pluginName;
        if (!manifest.name || !manifest.schema) {
          log.error(
            `skipping manifest without name/schema: ${manifestPath}`,
          );
          return null;
        }

        const baseDir = path.dirname(path.resolve(manifestPath));

        const schemaChain = (async () => {
          const s0 = Date.now();
          const schemaPath = await traceSpan(
            "discover:resolve-schema",
            () => resolveManifestModulePath(baseDir, manifest.schema),
            { parentKey: "db", meta: { plugin: pluginName } },
          );
          resolveSchemaMs = Date.now() - s0;

          const s1 = Date.now();
          const schemaModule = await traceSpan(
            "discover:import-schema",
            () => importFreshModule(schemaPath),
            { parentKey: "db", meta: { plugin: pluginName } },
          );
          importSchemaMs = Date.now() - s1;

          return { schemaPath, schemaModule };
        })();

        const migrationsChain = manifest.migrations
          ? (async () => {
              try {
                const m0 = Date.now();
                const migrationsPath = await traceSpan(
                  "discover:resolve-migrations",
                  () => resolveManifestModulePath(baseDir, manifest.migrations),
                  { parentKey: "db", meta: { plugin: pluginName } },
                );
                resolveMigrationsMs = Date.now() - m0;

                const m1 = Date.now();
                const stat = await fs.stat(migrationsPath);
                let migrations: any[];
                if (stat.isDirectory()) {
                  migrations = await traceSpan(
                    "discover:load-migrations-dir",
                    () => loadMigrationsFromDir(migrationsPath),
                    { parentKey: "db", meta: { plugin: pluginName } },
                  );
                } else {
                  const migModule = await traceSpan(
                    "discover:import-migrations",
                    () => importFreshModule(migrationsPath),
                    { parentKey: "db", meta: { plugin: pluginName } },
                  );
                  migrations =
                    migModule.migrations ?? migModule.default ?? [];
                }
                importMigrationsMs = Date.now() - m1;

                return { migrations, failed: false as const };
              } catch (error) {
                log.error(
                  `failed to load migrations from ${manifestPath}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return { migrations: [] as any[], failed: true as const };
              }
            })()
          : Promise.resolve({
              migrations: [] as any[],
              failed: false as const,
            });

        const [schemaResult, migrationsResult] = await Promise.all([
          schemaChain,
          migrationsChain,
        ]);

        if (migrationsResult.failed) return null;

        const schema =
          schemaResult.schemaModule.schema ?? schemaResult.schemaModule.default;
        if (!schema?.shape) {
          log.error(
            `schema module did not export a valid schema: ${schemaResult.schemaPath}`,
          );
          return null;
        }

        return { name: manifest.name, schema, migrations: migrationsResult.migrations };
      } catch (error) {
        log.error(
          `failed to load section from ${manifestPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      } finally {
        perPluginTimings.push({
          name: pluginName,
          manifestMs,
          resolveSchemaMs,
          importSchemaMs,
          resolveMigrationsMs,
          importMigrationsMs,
          totalMs: Date.now() - pluginStart,
        });
      }
    },
  );

  const resolvedSections = await Promise.all(tasks);
  // Preserve config.plugins order: Promise.all keeps indices, filter drops
  // failed ones without shuffling.
  const sections: SectionConfig[] = resolvedSections.filter(
    (s): s is SectionConfig => s !== null,
  );

  const sorted = [...perPluginTimings].sort((a, b) => b.totalMs - a.totalMs);
  const sum = (k: keyof (typeof perPluginTimings)[number]) =>
    perPluginTimings.reduce((acc, p) => acc + (p[k] as number), 0);
  log.verbose("per-plugin breakdown (ms, parallel):");
  log.verbose(
    `  ${"plugin".padEnd(28)} ${"total".padStart(6)} ${"man".padStart(
      5,
    )} ${"resS".padStart(5)} ${"impS".padStart(6)} ${"resM".padStart(
      5,
    )} ${"impM".padStart(6)}`,
  );
  for (const p of sorted) {
    log.verbose(
      `  ${p.name.padEnd(28)} ${String(p.totalMs).padStart(6)} ${String(
        p.manifestMs,
      ).padStart(5)} ${String(p.resolveSchemaMs).padStart(5)} ${String(
        p.importSchemaMs,
      ).padStart(6)} ${String(p.resolveMigrationsMs).padStart(5)} ${String(
        p.importMigrationsMs,
      ).padStart(6)}`,
    );
  }
  log.verbose(
    `  ${"SUM(cpu)".padEnd(28)} ${String(sum("totalMs")).padStart(6)} ${String(
      sum("manifestMs"),
    ).padStart(5)} ${String(sum("resolveSchemaMs")).padStart(5)} ${String(
      sum("importSchemaMs"),
    ).padStart(6)} ${String(sum("resolveMigrationsMs")).padStart(5)} ${String(
      sum("importMigrationsMs"),
    ).padStart(6)}`,
  );
  log.verbose(
    `  (wall time: look at db.discover-sections span — should be ~max(totalMs) not SUM)`,
  );

  return sections;
}

export class DbService extends Service {
  static key = "db";
  static deps = { http: HttpService };
  declare ctx: { http: HttpService };

  db: Db | null = null;
  dbRouter: ReturnType<typeof createRouter> | null = null;
  private sectionsHash = "";
  private _dbPath: string | null = null;

  /**
   * Resolved DB path. Throws if accessed before `evaluate()` has run — the
   * service contract guarantees deps are evaluated before dependents, so any
   * access from a dependent service or RPC handler is safe.
   */
  get dbPath(): string {
    if (this._dbPath === null) {
      throw new Error("DbService.dbPath accessed before evaluate()");
    }
    return this._dbPath;
  }

  get client(): SectionedClient {
    return this.db!.client as unknown as SectionedClient;
  }

  get effectClient(): SectionedEffectClient {
    return this.db!.effectClient as unknown as SectionedEffectClient;
  }

  /**
   * Drain kyju's lagged-persistence queue. Safe to call anytime; idempotent
   * when nothing is pending. Used by service teardown (effect cleanup) so
   * shutdown / hot-reload don't lose in-memory writes.
   */
  async flush(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.flush();
    } catch (err) {
      log.error("flush failed:", err);
    }
  }

  async evaluate() {
    const configPath = await resolveConfigPath();
    const configDir = path.dirname(configPath);
    const appConfig = await loadAppConfig(configPath);
    const [pluginSections, resolved] = await Promise.all([
      this.trace("discover-sections", () => discoverSections(configPath)),
      resolveDbPath(process.argv, {
        configDb: appConfig.db,
        configDir,
        configPath,
      }),
    ]);
    const sections = [coreSection, ...pluginSections];
    const sectionsHash = JSON.stringify(
      sections.map((s) => ({ name: s.name, v: s.migrations.length })),
    );
    const dbPath = resolved.path;

    if (
      !this.db ||
      this.sectionsHash !== sectionsHash ||
      this._dbPath !== dbPath
    ) {
      this.dbRouter = createRouter();
      this.db = await this.trace("create-db", () =>
        createDb({
          sections,
          path: dbPath,
          send: (event) => this.dbRouter!.send(event),
        }),
      );
      this.sectionsHash = sectionsHash;
      this._dbPath = dbPath;
      addDb(dbPath).catch((err) => {
        log.error("failed to bump registry lastUsedAt:", err);
      });
      log.verbose(
        `ready at ${dbPath} (source: ${resolved.source}, sections: ${sections
          .map((s) => `${s.name}@v${s.migrations.length}`)
          .join(", ")})`,
      );
    }

    const { http } = this.ctx;
    const wsDbConnections = new Map<
      string,
      { receive: (event: any) => Promise<void>; close: () => void }
    >();

    // Flush lagged kyju writes on any teardown (hot-reload OR shutdown).
    // Without this, in-memory writes that haven't yet hit setImmediate's
    // disk write would vanish when the Db instance is replaced/destroyed.
    this.setup("kyju-flush-on-cleanup", () => async () => {
      await this.flush();
    });

    this.setup("ws-transport", () => {
      const onConnected = (id: string, ws: WebSocket) => {
        const dbConn = this.dbRouter!.connection({
          send: (event: any) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(dbStringify({ ch: "db", data: event }));
            }
          },
          postMessage: this.db!.postMessage,
        });
        wsDbConnections.set(id, dbConn);

        ws.on("message", async (raw: Buffer) => {
          const msg = dbParse(String(raw));
          if (msg.ch === "db") {
            await dbConn.receive(msg.data);
          }
        });
      };

      const onDisconnected = (id: string) => {
        const conn = wsDbConnections.get(id);
        if (conn) {
          conn.close();
          wsDbConnections.delete(id);
        }
      };

      const unsubConnected = http.onConnected(onConnected);
      const unsubDisconnected = http.onDisconnected(onDisconnected);

      for (const [id, ws] of http.activeConnections) {
        onConnected(id, ws);
      }

      return () => {
        unsubConnected();
        unsubDisconnected();
        for (const conn of wsDbConnections.values()) conn.close();
        wsDbConnections.clear();
      };
    });
  }
}

runtime.register(DbService, import.meta);
