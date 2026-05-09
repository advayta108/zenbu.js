import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "@effect/platform/FileSystem";
import nodePath from "node:path";
import { nanoid } from "nanoid";
import type { Ack, ClientEvent, DbSendEvent, DbUpdateMessage, KyjuJSON, KyjuError, WriteOp } from "../shared";


export type DbConfig = {
  dbPath: string;
  /**
   * Single location for all in-flight atomic writes. Every `writeJsonFile`
   * stages to `${tmpDir}/${basename}-${nanoid}`, then renames to its final
   * path. Startup recovery reads just this one directory — O(pending) not
   * O(db size) — and by the time kyju starts, any file here is provably
   * orphaned.
   */
  tmpDir: string;
  rootName: string;
  collectionsDirName: string;
  collectionIndexName: string;
  pagesDirName: string;
  pageIndexName: string;
  pageDataName: string;
  blobsDirName: string;
  blobIndexName: string;
  blobDataName: string;
  maxPageSize: number;
  checkReferences: boolean;
};

export type Session = {
  sessionId: string;
  replicaId: string;
  subscriptions: Set<string>;
  send: (event: ClientEvent) => void;
};


export const paths = {
  root: ({ config }: { config: DbConfig }) =>
    nodePath.join(config.dbPath, config.rootName + ".json"),

  collection: ({ config, collectionId }: { config: DbConfig; collectionId: string }) =>
    nodePath.join(config.dbPath, config.collectionsDirName, collectionId),

  collectionIndex: ({ config, collectionId }: { config: DbConfig; collectionId: string }) =>
    nodePath.join(
      config.dbPath, config.collectionsDirName, collectionId,
      config.collectionIndexName + ".json",
    ),

  page: ({ config, collectionId, pageId }: { config: DbConfig; collectionId: string; pageId: string }) =>
    nodePath.join(
      config.dbPath, config.collectionsDirName, collectionId,
      config.pagesDirName, pageId,
    ),

  pageIndex: ({ config, collectionId, pageId }: { config: DbConfig; collectionId: string; pageId: string }) =>
    nodePath.join(
      config.dbPath, config.collectionsDirName, collectionId,
      config.pagesDirName, pageId, config.pageIndexName + ".json",
    ),

  pageData: ({ config, collectionId, pageId }: { config: DbConfig; collectionId: string; pageId: string }) =>
    nodePath.join(
      config.dbPath, config.collectionsDirName, collectionId,
      config.pagesDirName, pageId, config.pageDataName + ".jsonl",
    ),

  blob: ({ config, blobId }: { config: DbConfig; blobId: string }) =>
    nodePath.join(config.dbPath, config.blobsDirName, blobId),

  blobIndex: ({ config, blobId }: { config: DbConfig; blobId: string }) =>
    nodePath.join(config.dbPath, config.blobsDirName, blobId, config.blobIndexName + ".json"),

  blobData: ({ config, blobId }: { config: DbConfig; blobId: string }) =>
    nodePath.join(config.dbPath, config.blobsDirName, blobId, config.blobDataName),
};


export const makeAck = ({ requestId, sessionId, data }: {
  requestId: string;
  sessionId: string;
  data?: Record<string, unknown>;
}): Ack<any, any> => ({
  type: "ack" as const,
  requestId,
  sessionId,
  ...data,
});

export const makeErrorAck = ({ requestId, sessionId, _tag, message }: {
  requestId: string;
  sessionId?: string;
  _tag: KyjuError["_tag"];
  message: string;
}): Ack<any, any> => ({
  type: "ack" as const,
  requestId,
  sessionId: sessionId ?? "",
  error: { _tag, message } ,
});


export const broadcastWrite = ({ sessions, excludeSessionId, op }: {
  sessions: Map<string, Session>;
  excludeSessionId: string;
  op: WriteOp;
}) => {
  for (const [, session] of sessions) {
    if (session.sessionId === excludeSessionId) continue;
    session.send({ kind: "replicated-write", op });
  }
};

export const broadcastDbUpdate = ({ sessions, message }: {
  sessions: Map<string, Session>;
  message: DbUpdateMessage;
}) => {
  for (const [, session] of sessions) {
    session.send({ kind: "db-update", message });
  }
};

export const broadcastCollectionWrite = ({ sessions, excludeSessionId, collectionId, op }: {
  sessions: Map<string, Session>;
  excludeSessionId: string;
  collectionId: string;
  op: WriteOp;
}) => {
  for (const [, session] of sessions) {
    if (session.sessionId === excludeSessionId) continue;
    if (!session.subscriptions.has(collectionId)) continue;
    session.send({ kind: "replicated-write", op });
  }
};

export const broadcastCollectionDbUpdate = ({ sessions, collectionId, message }: {
  sessions: Map<string, Session>;
  collectionId: string;
  message: DbUpdateMessage;
}) => {
  for (const [, session] of sessions) {
    if (!session.subscriptions.has(collectionId)) continue;
    session.send({ kind: "db-update", message });
  }
};

export const sendAck = ({ session, ack }: { session: Session; ack: Ack<any, any> }) => {
  session.send({ kind: "db-update", message: ack });
};


/**
 * 
 *todo: explore this impl im very sus with the regex testing
 *
 */
export const setAtPath = ({ root, path: pathSegments, value }: {
  root: KyjuJSON;
  path: string[];
  value: KyjuJSON;
}): KyjuJSON => {
  if (pathSegments.length === 0) return value;

  const [head, ...rest] = pathSegments;
  const isIndex = /^\d+$/.test(head!);

  if (Array.isArray(root)) {
    const arr = root as KyjuJSON[];
    const index = Number(head);
    if (rest.length === 0) {
      arr[index] = value;
      return arr;
    }
    const nextRoot = arr[index] ?? (/^\d+$/.test(rest[0] ?? "") ? [] : {});
    arr[index] = setAtPath({
      root: nextRoot,
      path: rest,
      value,
    });
    return arr;
  }

  if (typeof root !== "object" || root === null) {
    root = isIndex ? [] : {};
  }

  if (Array.isArray(root)) {
    const arr = root as KyjuJSON[];
    const index = Number(head);
    if (rest.length === 0) {
      arr[index] = value;
      return arr;
    }
    const nextRoot = arr[index] ?? (/^\d+$/.test(rest[0] ?? "") ? [] : {});
    arr[index] = setAtPath({
      root: nextRoot,
      path: rest,
      value,
    });
    return arr;
  }

  const obj = root as Record<string, KyjuJSON>;
  if (rest.length === 0) {
    obj[head!] = value;
    return obj;
  }

  obj[head!] = setAtPath({
    root: obj[head!] ?? (/^\d+$/.test(rest[0] ?? "") ? [] : {}),
    path: rest,
    value,
  });
  return obj;
};

export type CollectionIndex = {
  activePageId: string;
  totalPages: number;
  totalCount: number;
};

export type PageIndex = {
  pageId: string;
  order: number;
};

export type BlobIndex = {
  blobId: string;
  fileSize: number;
};

export const createCollection = ({
  fs,
  config,
  collectionId,
  data,
}: {
  fs: FileSystem.FileSystem;
  config: DbConfig;
  collectionId: string;
  data?: KyjuJSON[];
}) =>
  Effect.gen(function* () {
    const pageId = nanoid();
    const items = data ?? [];

    yield* fs.makeDirectory(
      paths.page({ config, collectionId, pageId }),
      { recursive: true },
    );

    const jsonlContent =
      items.map((item) => JSON.stringify(item)).join("\n") +
      (items.length > 0 ? "\n" : "");

    yield* Effect.all([
      writeJsonFile({
        fs,
        config,
        path: paths.collectionIndex({ config, collectionId }),
        data: {
          activePageId: pageId,
          totalPages: 1,
          totalCount: items.length,
        } satisfies CollectionIndex,
      }),
      writeJsonFile({
        fs,
        config,
        path: paths.pageIndex({ config, collectionId, pageId }),
        data: { pageId, order: 0 } satisfies PageIndex,
      }),
      fs.writeFileString(
        paths.pageData({ config, collectionId, pageId }),
        jsonlContent,
      ),
    ]);
  });

export const createBlob = ({
  fs,
  config,
  blobId,
  data,
}: {
  fs: FileSystem.FileSystem;
  config: DbConfig;
  blobId: string;
  data: Uint8Array;
}) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(paths.blob({ config, blobId }), {
      recursive: true,
    });

    const dataPath = paths.blobData({ config, blobId });
    yield* fs.writeFile(dataPath, data);
    const stats = yield* fs.stat(dataPath);

    yield* writeJsonFile({
      fs,
      config,
      path: paths.blobIndex({ config, blobId }),
      data: {
        blobId,
        fileSize: Number(stats.size),
      } satisfies BlobIndex,
    });
  });

export const readJsonFile = ({ fs, path: filePath }: { fs: FileSystem.FileSystem; path: string }) =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(filePath);
    return JSON.parse(content) as KyjuJSON;
  });

/**
 * Atomic JSON write.
 *
 * Writes happen in two steps: the JSON is staged in the dedicated
 * `config.tmpDir` under a unique filename, then `rename(2)`'d over the
 * final path. `rename` is atomic within a filesystem, so readers always
 * observe either the prior contents or the fully-written new contents —
 * never a partial. A process death between write and rename leaves an
 * orphan tmp file; `cleanupStaleTmpFiles` sweeps those at boot.
 *
 * Staging all tmp files into a single, known directory (rather than
 * alongside each destination as `<file>.tmp-<id>`) means recovery is O(1)
 * in directory count: one readdir on `<dbPath>/.tmp/`. The previous
 * "sentinel suffix scattered across the tree" layout forced an O(db-size)
 * tree walk on every boot.
 *
 * Precondition: `config.tmpDir` must exist (createDb creates it during
 * init) and live on the same filesystem as `filePath` (always true when
 * both are under `config.dbPath`).
 */
export const writeJsonFile = ({
  fs,
  config,
  path: filePath,
  data,
}: {
  fs: FileSystem.FileSystem;
  config: DbConfig;
  path: string;
  data: unknown;
}) =>
  Effect.gen(function* () {
    const json = JSON.stringify(data);
    const tmpPath = nodePath.join(
      config.tmpDir,
      `${nodePath.basename(filePath)}-${nanoid(8)}`,
    );
    yield* fs.writeFileString(tmpPath, json);
    yield* fs.rename(tmpPath, filePath);
  });

/**
 * Reclaim orphan tmp files under `config.tmpDir`. Intended to run at
 * startup, before any writer is active — every file remaining in tmpDir
 * at that moment is by definition an orphan from a prior process (the
 * successful writes got rename'd away; the unsuccessful ones never made
 * it to their final destinations).
 *
 * O(pending tmp files), not O(db size). Single flat directory, no
 * recursion, no sentinel matching.
 */
export const cleanupStaleTmpFiles = (
  fs: FileSystem.FileSystem,
  tmpDir: string,
) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(tmpDir))) return;
    const entries = yield* fs.readDirectory(tmpDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    );
    for (const name of entries) {
      const full = nodePath.join(tmpDir, name);
      yield* fs.remove(full).pipe(
        Effect.catchAll((err) => {
          console.error(
            `[kyju:db] failed to remove stale tmp ${full}:`,
            err,
          );
          return Effect.void;
        }),
      );
    }
  });

export const readJsonlFile = ({ fs, path: filePath }: { fs: FileSystem.FileSystem; path: string }) =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(filePath);
    if (content.trim() === "") return [] as KyjuJSON[];
    return content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as KyjuJSON);
  });

/**
 * Read items from a collection by global index range [start, end).
 * Walks the page index to find which page files contain the requested
 * items, reads only those pages, and returns the sliced items plus
 * totalCount. Pages are a storage concern — callers get a flat item
 * array.
 */
export const readCollectionItemRange = ({
  fs,
  config,
  collectionId,
  start,
  end,
}: {
  fs: FileSystem.FileSystem;
  config: DbConfig;
  collectionId: string;
  start?: number;
  end?: number;
}) =>
  Effect.gen(function* () {
    const collectionDir = paths.collection({ config, collectionId });
    const pagesDir = nodePath.join(collectionDir, config.pagesDirName);
    const pageDirs = yield* fs.readDirectory(pagesDir);

    const pageIndexes = yield* Effect.all(
      pageDirs.map((pageId) =>
        Effect.gen(function* () {
          const pIdx = JSON.parse(
            yield* fs.readFileString(
              paths.pageIndex({ config, collectionId, pageId }),
            ),
          ) as PageIndex;
          return { id: pageId, order: pIdx.order };
        }),
      ),
      { concurrency: "unbounded" },
    );

    const sorted = pageIndexes.sort((a, b) => a.order - b.order);

    // Read all pages to build the full item list, then slice.
    // For large collections this could be optimized to skip pages
    // entirely outside the range, but correctness first.
    const allItems: KyjuJSON[] = [];
    for (const entry of sorted) {
      const dataPath = paths.pageData({ config, collectionId, pageId: entry.id });
      const pageItems = yield* readJsonlFile({ fs, path: dataPath });
      allItems.push(...pageItems);
    }

    const totalCount = allItems.length;
    const resolvedStart = start ?? 0;
    const resolvedEnd = end ?? totalCount;
    const items = allItems.slice(
      Math.max(0, resolvedStart),
      Math.min(totalCount, resolvedEnd),
    );

    return { items, totalCount };
  });

export type DbHandlerContext = {
  fs: FileSystem.FileSystem;
  config: DbConfig;
  sessionsRef: Ref.Ref<Map<string, Session>>;
  rootMutex: Effect.Semaphore;
  collectionMutex: Effect.Semaphore;
  blobMutex: Effect.Semaphore;
  dbSend: (event: DbSendEvent) => void;
  rootCache: import("./root-cache").RootCache;
};

export const validateSession = (
  ctx: DbHandlerContext,
  sessionId: string,
  requestId: string,
  replicaId: string,
) =>
  Effect.gen(function* () {
    const sessions = yield* Ref.get(ctx.sessionsRef);
    const session = sessions.get(sessionId);
    if (!session) {
      ctx.dbSend({
        kind: "db-update",
        replicaId,
        message: makeErrorAck({
          requestId,
          sessionId,
          _tag: "InvalidSessionError",
          message: "Invalid session",
        }),
      });
      return yield* Effect.fail("INVALID_SESSION" as const);
    }
    return session;
  });
