import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { nanoid } from "nanoid";
import nodePath from "node:path";
import type { DbSendEvent, KyjuJSON, ServerEvent } from "../shared";
import {
  type DbConfig,
  type Session,
  broadcastDbUpdate,
  cleanupStaleTmpFiles,
  createBlob,
  createCollection,
  paths,
  writeJsonFile,
} from "./helpers";
import { makeRootCache } from "./root-cache";
import { traceKyju } from "../trace";
import type { Schema, SchemaShape } from "./schema";
import type { KyjuMigration, SectionConfig } from "../migrations";
import type { DbHandlerContext } from "./helpers";
import { handleConnect } from "./handlers/connect";
import { handleDisconnect } from "./handlers/disconnect";
import { handleSubscribe } from "./handlers/subscribe";
import { handleUnsubscribe } from "./handlers/unsubscribe";
import { handleWrite } from "./handlers/write";
import { handleRead } from "./handlers/read";
import { runPlugins } from "./handlers/plugins";
import {
  createClient,
  createEffectClient,
  type ClientProxy,
  type EffectClientProxy,
} from "../client/client";
import {
  migrationPlugin,
  sectionMigrationPlugin,
} from "../core-plugins/migration";

export type { DbPlugin, PluginContext } from "./handlers/plugins";
export type { DbHandlerContext } from "./helpers";
export type { SectionConfig } from "../migrations";

import type { DbPlugin } from "./handlers/plugins";

export type CreateDbConfig<TShape extends SchemaShape = SchemaShape> = {
  path: string;
  send: (event: DbSendEvent) => void;
  maxPageSize?: number;
  checkReferences?: boolean;
  plugins?: DbPlugin[];
  schema?: Schema<TShape>;
  migrations?: KyjuMigration[];
  sections?: SectionConfig[];
};

export type Db<TShape extends SchemaShape = SchemaShape> = {
  postMessage: (event: ServerEvent) => Promise<void>;
  reconnectClients: () => Promise<void>;
  /**
   * Drain the lagged-persistence queue: writes that were applied to the
   * in-memory root cache but not yet committed to disk. Idempotent and
   * cheap when nothing is pending. Call before clean shutdown to ensure
   * durability of any writes that completed during this process's lifetime.
   */
  flush: () => Promise<void>;
  client: ClientProxy<TShape>;
  effectClient: EffectClientProxy<TShape>;
};

const DEFAULT_CONFIG: Omit<
  DbConfig,
  "dbPath" | "tmpDir" | "maxPageSize" | "checkReferences"
> = {
  rootName: "root",
  collectionsDirName: "collections",
  collectionIndexName: "index",
  pagesDirName: "pages",
  pageIndexName: "index",
  pageDataName: "data",
  blobsDirName: "blobs",
  blobIndexName: "index",
  blobDataName: "data",
};

const buildSchemaRoot = function* (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  schema: Schema,
) {
  const root: Record<string, KyjuJSON> = {};

  for (const [key, entry] of Object.entries(schema.shape)) {
    const fieldSchema = "schema" in entry ? entry.schema : entry;

    if ((fieldSchema as Record<string, unknown>).__kyjuCollectionRef) {
      const dn = (fieldSchema as Record<string, unknown>)._debugName;
      root[key] = {
        collectionId: "",
        debugName: typeof dn === "string" ? dn : key,
      };
    } else if ("type" in fieldSchema && fieldSchema.type === "blob") {
      const blobId = nanoid();
      root[key] = { blobId, debugName: fieldSchema.debugName ?? key };
      yield* createBlob({ fs, config, blobId, data: new Uint8Array(0) });
    } else if ((entry as any)._hasDefault) {
      root[key] = (entry as any)._defaultValue as KyjuJSON;
    }
  }

  return root;
};

const finalizeAndWriteRoot = function* (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  root: Record<string, KyjuJSON>,
) {
  const pendingCollections: Array<{ collectionId: string }> = [];
  const initNestedCollections = (obj: any): any => {
    if (obj == null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(initNestedCollections);
    if (
      typeof obj.collectionId === "string" &&
      typeof obj.debugName === "string" &&
      !obj.collectionId
    ) {
      const collectionId = nanoid();
      pendingCollections.push({ collectionId });
      return { ...obj, collectionId };
    }
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = initNestedCollections(v);
    }
    return result;
  };

  const finalRoot = initNestedCollections(root);
  for (const { collectionId } of pendingCollections) {
    yield* createCollection({ fs, config, collectionId });
  }

  yield* writeJsonFile({ fs, config, path: paths.root({ config }), data: finalRoot });
};

const initializeDbIfNeeded = (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  schema: Schema,
) =>
  Effect.gen(function* () {
    const rootPath = paths.root({ config });
    if (yield* fs.exists(rootPath)) return;
    yield* fs.makeDirectory(config.dbPath, { recursive: true });

    const root = yield* buildSchemaRoot(fs, config, schema);
    yield* finalizeAndWriteRoot(fs, config, root);
  });

const initializeSectionedDbIfNeeded = (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  sections: SectionConfig[],
) =>
  Effect.gen(function* () {
    const rootPath = paths.root({ config });
    if (yield* fs.exists(rootPath)) return;
    yield* fs.makeDirectory(config.dbPath, { recursive: true });

    const sectionsData: Record<string, KyjuJSON> = {};
    for (const section of sections) {
      sectionsData[section.name] = yield* buildSchemaRoot(
        fs,
        config,
        section.schema,
      );
    }

    yield* finalizeAndWriteRoot(fs, config, {
      plugin: sectionsData,
    } as Record<string, KyjuJSON>);
  });

const createDbEffect = <TShape extends SchemaShape>(
  userConfig: CreateDbConfig<TShape>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const config: DbConfig = {
      ...DEFAULT_CONFIG,
      dbPath: userConfig.path,
      tmpDir: nodePath.join(userConfig.path, ".tmp"),
      maxPageSize: userConfig.maxPageSize ?? 1024 * 1024,
      checkReferences: userConfig.checkReferences ?? false,
    };

    // Ensure the dedicated tmp staging directory exists before anything else
    // can try to write. Every `writeJsonFile` stages through `config.tmpDir`
    // and then renames to its destination; the rename is only atomic when
    // both paths live on the same filesystem, which they do by construction
    // (both under `dbPath`).
    yield* fs.makeDirectory(config.tmpDir, { recursive: true });

    yield* traceKyju(
      "kyju:db.init.dir-setup",
      Effect.gen(function* () {
        if (userConfig.sections) {
          const names = userConfig.sections.map((s) => s.name);
          const dupes = names.filter((n, i) => names.indexOf(n) !== i);
          if (dupes.length > 0) {
            throw new Error(
              `Duplicate section names: ${[...new Set(dupes)].join(", ")}`,
            );
          }
          yield* initializeSectionedDbIfNeeded(fs, config, userConfig.sections);
        } else if (userConfig.schema) {
          yield* initializeDbIfNeeded(fs, config, userConfig.schema);
        }
      }),
    );

    // Reclaim orphan tmp files from prior processes. Runs inline — it's a
    // single flat `readdir` on a directory that's empty in the common case,
    // so it costs nothing when there's nothing to clean. Safe because no
    // writer is active yet: every file currently in `tmpDir` is by
    // definition an orphan (successful writes were renamed away).
    yield* traceKyju(
      "kyju:db.init.tmp-cleanup",
      cleanupStaleTmpFiles(fs, config.tmpDir).pipe(
        Effect.catchAll((err) => {
          console.error("[kyju:db] tmp sweep failed (non-fatal):", err);
          return Effect.void;
        }),
      ),
    );

    const sessionsRef = yield* Ref.make(new Map<string, Session>());
    const rootMutex = yield* Effect.makeSemaphore(1);
    const collectionMutex = yield* Effect.makeSemaphore(1);
    const blobMutex = yield* Effect.makeSemaphore(1);
    const latch = yield* Effect.makeLatch(false);

    // Hydrate the in-memory root cache from disk. Must run AFTER
    // `initializeDbIfNeeded` (which writes the initial root if missing) so
    // there's something to read; runs BEFORE `runPlugins` (which executes
    // migrations via client.update → handleWrite, which now reads/writes
    // through the cache).
    const rootCache = yield* traceKyju(
      "kyju:db.init.make-cache",
      makeRootCache(fs, config, rootMutex),
    );

    const ctx: DbHandlerContext = {
      fs,
      config,
      sessionsRef,
      rootMutex,
      collectionMutex,
      blobMutex,
      dbSend: userConfig.send,
      rootCache,
    };

    const postMessageEffect = (event: ServerEvent) =>
      Effect.gen(function* () {
        switch (event.kind) {
          case "connect":
            return yield* handleConnect(ctx, event, latch);
          case "disconnect":
            return yield* handleDisconnect(ctx, event);
          case "subscribe-collection":
            return yield* handleSubscribe(ctx, event);
          case "unsubscribe-collection":
            return yield* handleUnsubscribe(ctx, event);
          case "write":
            return yield* handleWrite(ctx, event);
          case "read":
            return yield* handleRead(ctx, event);
        }
      }).pipe(Effect.catchAll((err) => {
        console.error("[kyju:db] unhandled error in postMessage handler:", err);
        return Effect.void;
      }));

    const reconnectClientsEffect = Effect.gen(function* () {
      const sessions = yield* Ref.get(sessionsRef);
      broadcastDbUpdate({
        sessions,
        message: { type: "reconnect" },
      });
    });

    let plugins: DbPlugin[];
    if (userConfig.sections) {
      plugins = [
        sectionMigrationPlugin(userConfig.sections),
        ...(userConfig.plugins ?? []),
      ];
    } else {
      plugins = [
        migrationPlugin(userConfig.migrations ?? []),
        ...(userConfig.plugins ?? []),
      ];
    }

    const localReplica = yield* traceKyju(
      "kyju:db.init.run-plugins",
      runPlugins(ctx, postMessageEffect, plugins),
    );
    yield* latch.open;

    // Migrations may have written to the root cache; drain to disk before
    // returning so the on-disk state reflects all pre-start work. If we
    // crashed between createDb resolving and the next flush, the next boot
    // would otherwise re-run migrations (since their effects live in cache).
    yield* traceKyju("kyju:db.init.final-flush", rootCache.flush());

    const client = createClient<TShape>(localReplica);
    const effectClient = createEffectClient<TShape>(localReplica);

    return {
      postMessage: (event: ServerEvent): Promise<void> =>
        Effect.runPromise(postMessageEffect(event)),
      reconnectClients: (): Promise<void> =>
        Effect.runPromise(reconnectClientsEffect),
      flush: (): Promise<void> => Effect.runPromise(rootCache.flush()),
      client,
      effectClient,
    };
  });

export const createDb = async <TShape extends SchemaShape>(
  config: CreateDbConfig<TShape>,
): Promise<Db<TShape>> => {
  return Effect.runPromise(
    createDbEffect(config).pipe(Effect.provide(NodeFileSystem.layer)),
  );
};
