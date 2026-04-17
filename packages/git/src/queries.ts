import { runGit, gitOrThrow } from "./runner"
import type {
  AheadBehind,
  Branch,
  Commit,
  FileChange,
  MergeCheck,
  WorkingTreeStatus,
  Worktree,
} from "./types"

export async function isRepo(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--git-dir"])
  return result.code === 0
}

export async function isShallow(cwd: string): Promise<boolean> {
  const out = await gitOrThrow(cwd, ["rev-parse", "--is-shallow-repository"])
  return out.trim() === "true"
}

export async function getBranch(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
  if (result.code !== 0) return null
  return result.stdout.trim() || null
}

export async function getRemoteUrl(cwd: string, remote = "origin"): Promise<string | null> {
  const result = await runGit(cwd, ["remote", "get-url", remote])
  if (result.code !== 0) return null
  return result.stdout.trim() || null
}

export type FetchOptions = {
  remote?: string
  branch?: string
  deepen?: number
  unshallow?: boolean
}

export async function fetch(cwd: string, opts: FetchOptions = {}): Promise<void> {
  const args = ["fetch"]
  if (opts.unshallow) args.push("--unshallow")
  else if (opts.deepen !== undefined) args.push(`--deepen=${opts.deepen}`)
  if (opts.remote) args.push(opts.remote)
  if (opts.branch) args.push(opts.branch)
  await gitOrThrow(cwd, args)
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  const out = await gitOrThrow(cwd, ["rev-parse", ref])
  return out.trim()
}

export async function getAheadBehind(cwd: string, from: string, to: string): Promise<AheadBehind> {
  const out = await gitOrThrow(cwd, ["rev-list", "--left-right", "--count", `${from}...${to}`])
  const [aheadStr, behindStr] = out.trim().split(/\s+/)
  return {
    ahead: Number.parseInt(aheadStr ?? "0", 10) || 0,
    behind: Number.parseInt(behindStr ?? "0", 10) || 0,
  }
}

function parseStatusCode(code: string): FileChange["status"] {
  switch (code) {
    case "A": return "added"
    case "M": return "modified"
    case "D": return "deleted"
    case "R": return "renamed"
    case "C": return "copied"
    case "T": return "typechange"
    default: return "unknown"
  }
}

export async function getStatus(cwd: string): Promise<WorkingTreeStatus> {
  const out = await gitOrThrow(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const staged: FileChange[] = []
  const unstaged: FileChange[] = []
  const untracked: string[] = []
  const conflicted: string[] = []

  if (!out.length) return { staged, unstaged, untracked, conflicted }

  const entries = out.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const x = entry[0]!
    const y = entry[1]!
    const rest = entry.slice(3)

    if (x === "?" && y === "?") {
      untracked.push(rest)
      continue
    }
    if (x === "!" && y === "!") {
      continue
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted.push(rest)
      continue
    }

    let path = rest
    let oldPath: string | null = null
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const src = entries[i + 1]
      if (src !== undefined) {
        oldPath = src
        i++
      }
    }

    if (x !== " " && x !== "?") {
      staged.push({ path, oldPath, status: parseStatusCode(x) })
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ path, oldPath, status: parseStatusCode(y) })
    }
  }

  return { staged, unstaged, untracked, conflicted }
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await getStatus(cwd)
  return (
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.conflicted.length > 0 ||
    status.untracked.length > 0
  )
}

const COMMIT_FIELD_SEP = "\x1f"
const COMMIT_RECORD_SEP = "\x1e"
const COMMIT_FORMAT = [
  "%H",
  "%h",
  "%s",
  "%b",
  "%an",
  "%ae",
  "%at",
].join(COMMIT_FIELD_SEP)

function parseCommitRecord(record: string): Commit | null {
  const parts = record.split(COMMIT_FIELD_SEP)
  if (parts.length < 7) return null
  const [sha, shortSha, subject, body, authorName, authorEmail, authorTs] = parts
  return {
    sha: sha!.trim(),
    shortSha: shortSha!.trim(),
    subject: subject!,
    body: body!,
    authorName: authorName!,
    authorEmail: authorEmail!,
    authorDate: (Number.parseInt(authorTs!.trim(), 10) || 0) * 1000,
  }
}

export async function getCommit(cwd: string, ref: string): Promise<Commit> {
  const out = await gitOrThrow(cwd, [
    "show",
    "--no-patch",
    `--pretty=format:${COMMIT_FORMAT}`,
    ref,
  ])
  const commit = parseCommitRecord(out)
  if (!commit) throw new Error(`Failed to parse commit for ref "${ref}"`)
  return commit
}

export type LogOptions = { ref?: string; limit?: number }

export async function getLog(cwd: string, opts: LogOptions = {}): Promise<Commit[]> {
  const args = ["log", `--pretty=format:${COMMIT_FORMAT}${COMMIT_RECORD_SEP}`]
  if (opts.limit !== undefined) args.push(`-n${opts.limit}`)
  if (opts.ref) args.push(opts.ref)
  const out = await gitOrThrow(cwd, args)
  const records = out.split(COMMIT_RECORD_SEP).map((r) => r.replace(/^\n+/, "")).filter(Boolean)
  const commits: Commit[] = []
  for (const record of records) {
    const commit = parseCommitRecord(record)
    if (commit) commits.push(commit)
  }
  return commits
}

export async function getBranches(cwd: string): Promise<Branch[]> {
  const format = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname)",
    "%(HEAD)",
    "%(upstream:short)",
  ].join(COMMIT_FIELD_SEP)
  const out = await gitOrThrow(cwd, [
    "for-each-ref",
    `--format=${format}`,
    "refs/heads",
    "refs/remotes",
  ])
  const branches: Branch[] = []
  for (const line of out.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split(COMMIT_FIELD_SEP)
    if (parts.length < 5) continue
    const [fullRef, shortRef, sha, headMarker, upstream] = parts
    branches.push({
      name: shortRef!,
      isCurrent: headMarker === "*",
      isRemote: fullRef!.startsWith("refs/remotes/"),
      upstream: upstream!.trim() || null,
      sha: sha!,
    })
  }
  return branches
}

export async function getWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await gitOrThrow(cwd, ["worktree", "list", "--porcelain"])
  const trees: Worktree[] = []
  let current: Partial<Worktree> | null = null

  const flush = () => {
    if (current && current.path) {
      trees.push({
        path: current.path,
        sha: current.sha ?? null,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        bare: current.bare ?? false,
        locked: current.locked ?? false,
      })
    }
    current = null
  }

  for (const line of out.split("\n")) {
    if (!line.length) {
      flush()
      continue
    }
    const [key, ...rest] = line.split(" ")
    const value = rest.join(" ")
    if (key === "worktree") {
      flush()
      current = { path: value }
    } else if (key === "HEAD") {
      if (current) current.sha = value
    } else if (key === "branch") {
      if (current) {
        current.branch = value.replace(/^refs\/heads\//, "")
        current.detached = false
      }
    } else if (key === "detached") {
      if (current) current.detached = true
    } else if (key === "bare") {
      if (current) current.bare = true
    } else if (key === "locked") {
      if (current) current.locked = true
    }
  }
  flush()
  return trees
}

export async function checkMerge(cwd: string, base: string, incoming: string): Promise<MergeCheck> {
  const result = await runGit(cwd, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    base,
    incoming,
  ])
  if (result.code === 0) {
    return { clean: true, conflictingFiles: [] }
  }
  if (result.code === 1) {
    const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    return { clean: false, conflictingFiles: lines.slice(1) }
  }
  throw new Error(
    `git merge-tree exited with code ${result.code}: ${result.stderr.trim() || "<no stderr>"}`,
  )
}
