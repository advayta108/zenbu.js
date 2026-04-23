import { Effect, Ref } from "effect";
import { FileSystem } from "@effect/platform";
import nodePath from "node:path";
import { nanoid } from "nanoid";
import type { Ack, ClientEvent, DbSendEvent, DbUpdateMessage, KyjuJSON, KyjuError, WriteOp } from "../shared";


export type DbConfig = {
  dbPath: string;
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
        path: paths.collectionIndex({ config, collectionId }),
        data: {
          activePageId: pageId,
          totalPages: 1,
          totalCount: items.length,
        } satisfies CollectionIndex,
      }),
      writeJsonFile({
        fs,
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
 * Atomic JSON write: write to a sibling tempfile then `rename` over the
 * destination. Prevents a process-kill mid-write (Electron shutdown,
 * SIGABRT, ctrl-C) from leaving the file truncated to zero bytes — a
 * non-atomic `writeFileString` opens with O_TRUNC|O_CREAT and the file
 * is empty until the write completes, so any death in that window
 * corrupts callers that JSON.parse it next boot ("Unexpected end of
 * JSON input").
 *
 * `rename(2)` on POSIX is atomic within the same filesystem, so readers
 * always see either the old contents or the fully-written new contents,
 * never a partial. Tmp filenames carry a nanoid suffix so concurrent
 * writes can't clobber each other.
 */
export const TMP_SUFFIX_PREFIX = ".tmp-";

export const writeJsonFile = ({ fs, path: filePath, data }: { fs: FileSystem.FileSystem; path: string; data: unknown }) =>
  Effect.gen(function* () {
    const json = JSON.stringify(data);
    const tmpPath = `${filePath}${TMP_SUFFIX_PREFIX}${nanoid(8)}`;
    yield* fs.writeFileString(tmpPath, json);
    yield* fs.rename(tmpPath, filePath);
  });

/**
 * Sweep orphaned `*.tmp-<nanoid>` files under `dbPath`. These can be
 * left behind if the process was hard-killed between `writeFileString`
 * and `rename` in `writeJsonFile`. Safe to call once on init — by then
 * no writer is active yet so any tmp file is provably stale. Best-effort:
 * a single file we fail to delete doesn't abort the rest.
 */
export const cleanupStaleTmpFiles = (
  fs: FileSystem.FileSystem,
  dbPath: string,
) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(dbPath))) return;
    yield* sweepDir(fs, dbPath);
  });

const sweepDir = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const entries = (yield* fs.readDirectory(dir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )) as string[];
    for (const name of entries) {
      const full = nodePath.join(dir, name);
      const stat = yield* fs.stat(full).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!stat) continue;
      if (stat.type === "Directory") {
        yield* sweepDir(fs, full);
        continue;
      }
      // We only delete files whose basename includes our well-known
      // sentinel — never touch user data.
      if (name.includes(TMP_SUFFIX_PREFIX)) {
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
