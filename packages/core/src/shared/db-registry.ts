import fsp from "node:fs/promises"
import path from "node:path"
import { DB_CONFIG_JSON, INTERNAL_DIR } from "./paths"

/**
 * what?
 */
/**
 * Persisted at `~/.zenbu/.internal/db.json`. Tracks every DB path the CLI has
 * seen plus an optional default selection. Lives outside any kyju DB on
 * purpose: the registry has to survive a DB switch (the chicken-and-egg).
 *
 * Legacy shape was `{ dbPath: string }` written by setup.ts; `loadRegistry`
 * upgrades that in place on first read.
 */
export type DbEntry = {
  path: string
  lastUsedAt: number
}

export type DbRegistry = {
  defaultDbPath: string | null
  dbs: DbEntry[]
}

const DEFAULT_REGISTRY: DbRegistry = {
  defaultDbPath: null,
  dbs: [],
}

function normalize(p: string): string {
  return path.resolve(p)
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(INTERNAL_DIR, { recursive: true })
}

export async function loadRegistry(): Promise<DbRegistry> {
  let raw: unknown
  try {
    const text = await fsp.readFile(DB_CONFIG_JSON, "utf8")
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULT_REGISTRY }
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_REGISTRY }
  const obj = raw as Record<string, unknown>
  /**
   * legacy? no
   */

  // Legacy shape: { dbPath: "..." } — promote to defaultDbPath + single entry.
  if (
    typeof obj.dbPath === "string" &&
    obj.defaultDbPath === undefined &&
    obj.dbs === undefined
  ) {
    const p = normalize(obj.dbPath)
    const upgraded: DbRegistry = {
      defaultDbPath: p,
      dbs: [{ path: p, lastUsedAt: Date.now() }],
    }
    await saveRegistry(upgraded)
    return upgraded
  }

  const defaultDbPath =
    typeof obj.defaultDbPath === "string" ? normalize(obj.defaultDbPath) : null
  const dbs: DbEntry[] = Array.isArray(obj.dbs)
    ? obj.dbs
        .filter(
          (e): e is { path: string; lastUsedAt?: number } =>
            !!e &&
            typeof e === "object" &&
            typeof (e as { path?: unknown }).path === "string",
        )
        .map((e) => ({
          path: normalize(e.path),
          lastUsedAt: typeof e.lastUsedAt === "number" ? e.lastUsedAt : 0,
        }))
    : []

  return { defaultDbPath, dbs }
}

export async function saveRegistry(reg: DbRegistry): Promise<void> {
  await ensureDir()
  await fsp.writeFile(DB_CONFIG_JSON, JSON.stringify(reg, null, 2))
}

export async function addDb(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath)
  await fsp.mkdir(p, { recursive: true })
  const reg = await loadRegistry()
  const now = Date.now()
  const existing = reg.dbs.find((e) => e.path === p)
  if (existing) {
    existing.lastUsedAt = now
  } else {
    reg.dbs.push({ path: p, lastUsedAt: now })
  }
  await saveRegistry(reg)
  return reg
}

export async function removeDb(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath)
  const reg = await loadRegistry()
  reg.dbs = reg.dbs.filter((e) => e.path !== p)
  if (reg.defaultDbPath === p) reg.defaultDbPath = null
  await saveRegistry(reg)
  return reg
}

export async function setDefault(absPath: string): Promise<DbRegistry> {
  const p = normalize(absPath)
  await fsp.mkdir(p, { recursive: true })
  const reg = await loadRegistry()
  if (!reg.dbs.some((e) => e.path === p)) {
    reg.dbs.push({ path: p, lastUsedAt: Date.now() })
  }
  reg.defaultDbPath = p
  await saveRegistry(reg)
  return reg
}

export type ResolvedDb = {
  path: string
  source: "flag" | "config"
}

const FLAG_PREFIX = "--zen-db-path="

/**
 * Resolve the active DB path. The app's `config.json` is the single source of
 * truth: every project that uses Zenbu must declare `"db": "<path>"` (relative
 * to `config.json` or absolute). The only override is `--zen-db-path=<x>` for
 * one-off dev runs (e.g. `zen --db /tmp/scratch .`). There is no global
 * fallback by design — we don't want a project's data location to depend on
 * the developer's machine state.
 *
 * The recently-used registry at `~/.zenbu/.internal/db.json` is *only* a
 * convenience index for `zen db list / pick` navigation; it does not drive
 * resolution.
 *
 * Always mkdir -p before returning so DbService can hand the path straight to
 * kyju without an extra existence check.
 */
export async function resolveDbPath(
  argv: string[],
  app: { configDb: string; configDir: string; configPath: string },
): Promise<ResolvedDb> {
  for (const arg of argv) {
    if (arg.startsWith(FLAG_PREFIX)) {
      const p = normalize(arg.slice(FLAG_PREFIX.length))
      await fsp.mkdir(p, { recursive: true })
      return { path: p, source: "flag" }
    }
  }
  if (!app.configDb || typeof app.configDb !== "string") {
    throw new Error(
      `Zenbu config is missing the required "db" field at ${app.configPath}.\n` +
        `Add a relative or absolute path, e.g. \`{ "db": "./.zenbu/db", "plugins": [...] }\`.`,
    )
  }
  const resolved = normalize(
    path.isAbsolute(app.configDb)
      ? app.configDb
      : path.resolve(app.configDir, app.configDb),
  )
  await fsp.mkdir(resolved, { recursive: true })
  return { path: resolved, source: "config" }
}
