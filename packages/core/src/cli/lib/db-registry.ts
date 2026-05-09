import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INTERNAL_DIR = path.join(os.homedir(), ".zenbu", ".internal");
const DB_CONFIG_JSON = path.join(INTERNAL_DIR, "db.json");

export type DbEntry = {
  path: string;
  lastUsedAt: number;
};

export type DbRegistry = {
  defaultDbPath: string | null;
  dbs: DbEntry[];
};

const DEFAULT_REGISTRY: DbRegistry = {
  defaultDbPath: null,
  dbs: [],
};

function normalize(p: string): string {
  return path.resolve(p);
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(INTERNAL_DIR, { recursive: true });
}

export async function loadRegistry(): Promise<DbRegistry> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(DB_CONFIG_JSON, "utf8"));
  } catch {
    return { ...DEFAULT_REGISTRY };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_REGISTRY };
  const obj = raw as Record<string, unknown>;
  const defaultDbPath =
    typeof obj.defaultDbPath === "string" ? normalize(obj.defaultDbPath) : null;
  const dbs: DbEntry[] = Array.isArray(obj.dbs)
    ? obj.dbs
        .filter(
          (entry): entry is { path: string; lastUsedAt?: number } =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as { path?: unknown }).path === "string",
        )
        .map((entry) => ({
          path: normalize(entry.path),
          lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : 0,
        }))
    : [];
  return { defaultDbPath, dbs };
}

export async function saveRegistry(registry: DbRegistry): Promise<void> {
  await ensureDir();
  await fsp.writeFile(DB_CONFIG_JSON, JSON.stringify(registry, null, 2));
}

export async function addDb(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath);
  await fsp.mkdir(p, { recursive: true });
  const registry = await loadRegistry();
  const existing = registry.dbs.find((entry) => entry.path === p);
  if (existing) existing.lastUsedAt = Date.now();
  else registry.dbs.push({ path: p, lastUsedAt: Date.now() });
  await saveRegistry(registry);
  return registry;
}

export async function removeDb(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath);
  const registry = await loadRegistry();
  registry.dbs = registry.dbs.filter((entry) => entry.path !== p);
  if (registry.defaultDbPath === p) registry.defaultDbPath = null;
  await saveRegistry(registry);
  return registry;
}

export async function setDefault(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath);
  await fsp.mkdir(p, { recursive: true });
  const registry = await loadRegistry();
  if (!registry.dbs.some((entry) => entry.path === p)) {
    registry.dbs.push({ path: p, lastUsedAt: Date.now() });
  }
  registry.defaultDbPath = p;
  await saveRegistry(registry);
  return registry;
}
