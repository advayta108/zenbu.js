import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCb)

export interface MirrorPushOptions {
  staging: string
  mirrorUrl: string
  branch?: string
  sourceSha: string
  authorName?: string
  authorEmail?: string
  commitTitle?: string
  force?: boolean
}

export interface MirrorPushResult {
  status: "pushed" | "noop"
  mirrorSha?: string
  reason?: string
}

const SYNCED_FROM_RE = /\[synced from ([0-9a-f]{7,40})\]/

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const { stdout } = await execFile("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function gitTry(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

async function shallowCloneMirror(mirrorUrl: string, branch: string): Promise<{ dir: string; isEmpty: boolean }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-mirror-"))
  try {
    await git(dir, ["clone", "--depth", "1", "--branch", branch, mirrorUrl, "."])
    return { dir, isEmpty: false }
  } catch {
    await git(dir, ["init", "-b", branch])
    await git(dir, ["remote", "add", "origin", mirrorUrl])
    return { dir, isEmpty: true }
  }
}

async function readHeadSyncedFromSha(repoDir: string): Promise<string | null> {
  const headExists = await gitTry(repoDir, ["rev-parse", "HEAD"])
  if (!headExists) return null
  const message = await git(repoDir, ["log", "-1", "--format=%B"])
  const match = SYNCED_FROM_RE.exec(message)
  return match?.[1] ?? null
}

async function emptyTrackedTree(repoDir: string): Promise<void> {
  const entries = await fsp.readdir(repoDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".git") continue
    const target = path.join(repoDir, entry.name)
    await fsp.rm(target, { recursive: true, force: true })
  }
}

async function copyTree(source: string, dest: string): Promise<void> {
  const entries = await fsp.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".sha") continue
    const src = path.join(source, entry.name)
    const dst = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await fsp.mkdir(dst, { recursive: true })
      await copyTree(src, dst)
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(src)
      await fsp.symlink(link, dst)
    } else {
      await fsp.copyFile(src, dst)
    }
  }
}

async function commitAndPush(
  repoDir: string,
  branch: string,
  sourceSha: string,
  options: { commitTitle?: string; authorName?: string; authorEmail?: string },
): Promise<{ pushed: boolean; sha: string | null; reason?: string }> {
  await git(repoDir, ["add", "-A"])

  const status = await git(repoDir, ["status", "--porcelain"])
  if (!status.trim()) {
    const head = await gitTry(repoDir, ["rev-parse", "HEAD"])
    return { pushed: false, sha: head?.trim() ?? null, reason: "no changes" }
  }

  const env: Record<string, string> = { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: "0" }
  if (options.authorName) {
    env.GIT_AUTHOR_NAME = options.authorName
    env.GIT_COMMITTER_NAME = options.authorName
  }
  if (options.authorEmail) {
    env.GIT_AUTHOR_EMAIL = options.authorEmail
    env.GIT_COMMITTER_EMAIL = options.authorEmail
  }

  const title = options.commitTitle ?? `chore: sync source ${sourceSha.slice(0, 7)}`
  const message = `${title}\n\n[synced from ${sourceSha}]\n`

  await execFile("git", ["commit", "-m", message], { cwd: repoDir, env })
  await execFile("git", ["push", "origin", `HEAD:${branch}`], { cwd: repoDir, env })
  const head = await git(repoDir, ["rev-parse", "HEAD"])
  return { pushed: true, sha: head.trim() }
}

/**
 * Seed an empty mirror with the staged content. Fails if the mirror's HEAD
 * already has a `[synced from <sha>]` trailer (unless `force`).
 */
export async function init(options: MirrorPushOptions): Promise<MirrorPushResult> {
  const branch = options.branch ?? "main"
  const { dir: workDir } = await shallowCloneMirror(options.mirrorUrl, branch)
  try {
    const existing = await readHeadSyncedFromSha(workDir)
    if (existing && !options.force) {
      throw new Error(
        `mirror already initialized (HEAD has [synced from ${existing.slice(0, 7)}]); use \`zen publish:source push\` instead, or pass --force`,
      )
    }

    await emptyTrackedTree(workDir)
    await copyTree(options.staging, workDir)

    const result = await commitAndPush(workDir, branch, options.sourceSha, {
      commitTitle: options.commitTitle,
      authorName: options.authorName,
      authorEmail: options.authorEmail,
    })
    if (!result.pushed) {
      return { status: "noop", reason: result.reason }
    }
    return { status: "pushed", mirrorSha: result.sha ?? undefined }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Snapshot the staging dir into a new mirror commit. Refuses if the mirror
 * has no `[synced from]` trailer. No-ops if the existing trailer's source SHA
 * already matches `sourceSha` (mirror is up to date).
 */
export async function push(options: MirrorPushOptions): Promise<MirrorPushResult> {
  const branch = options.branch ?? "main"
  const { dir: workDir, isEmpty } = await shallowCloneMirror(options.mirrorUrl, branch)
  try {
    if (isEmpty) {
      throw new Error(
        "mirror is empty; run `zen publish:source init` first",
      )
    }

    const lastSynced = await readHeadSyncedFromSha(workDir)
    if (!lastSynced) {
      throw new Error(
        "mirror not initialized (HEAD has no [synced from] trailer); run `zen publish:source init` first",
      )
    }

    if (lastSynced === options.sourceSha) {
      return { status: "noop", reason: "already up to date" }
    }

    await emptyTrackedTree(workDir)
    await copyTree(options.staging, workDir)

    const result = await commitAndPush(workDir, branch, options.sourceSha, {
      commitTitle: options.commitTitle,
      authorName: options.authorName,
      authorEmail: options.authorEmail,
    })
    if (!result.pushed) {
      return { status: "noop", reason: result.reason }
    }
    return { status: "pushed", mirrorSha: result.sha ?? undefined }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Initialize a local git working tree at `dir` whose `origin` is `mirrorUrl`
 * and whose HEAD is a fresh commit of `dir`'s contents. Used by `build:desktop`
 * to make the seed inside the .app a real git repo, so the user's apps-dir
 * after first launch can later `git pull` from the mirror.
 *
 * The commit SHA produced here is local-only; on the user's machine, after a
 * future `zen pull`, they'll fast-forward to whatever's actually on the
 * mirror.
 */
export async function initSeedRepo(options: {
  dir: string
  mirrorUrl: string
  branch?: string
  sourceSha: string
}): Promise<void> {
  const branch = options.branch ?? "main"
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }

  if (!fs.existsSync(path.join(options.dir, ".git"))) {
    await execFile("git", ["init", "-b", branch], { cwd: options.dir, env })
  }
  await execFile("git", ["remote", "remove", "origin"], { cwd: options.dir, env }).catch(() => {})
  await execFile("git", ["remote", "add", "origin", options.mirrorUrl], { cwd: options.dir, env })
  await execFile("git", ["add", "-A"], { cwd: options.dir, env })

  const localEnv: Record<string, string> = {
    ...env as Record<string, string>,
    GIT_AUTHOR_NAME: "zenbu",
    GIT_COMMITTER_NAME: "zenbu",
    GIT_AUTHOR_EMAIL: "zenbu@local",
    GIT_COMMITTER_EMAIL: "zenbu@local",
  }
  const message = `seed ${options.sourceSha.slice(0, 7)}\n\n[synced from ${options.sourceSha}]\n`
  await execFile("git", ["commit", "--allow-empty", "-m", message], { cwd: options.dir, env: localEnv })
}

/** Hash a directory tree's content; used by `build:source` for the .sha file. */
export async function hashDir(dir: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  const entries: string[] = []
  await collectFiles(dir, dir, entries)
  entries.sort()
  for (const rel of entries) {
    const buf = await fsp.readFile(path.join(dir, rel))
    hash.update(rel)
    hash.update("\0")
    hash.update(buf)
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function collectFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".git") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(root, full, out)
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join("/"))
    }
  }
}
