import os from "node:os"
import path from "node:path"
import {
  GitCommandError,
  GitMissingError,
  checkMerge,
  checkout as gitCheckout,
  commit as gitCommit,
  createBranch as gitCreateBranch,
  deleteBranch as gitDeleteBranch,
  fetch as gitFetch,
  getAheadBehind,
  getBranch,
  getBranches,
  getCommit,
  getLog,
  getRemoteUrl,
  getStatus,
  getWorktrees,
  isRepo,
  isShallow,
  parseRemoteUrl,
  pull as gitPull,
  push as gitPush,
  resolveRef,
  type Branch,
  type Commit,
  type WorkingTreeStatus,
  type Worktree,
} from "@zenbu/git"
import { Service, runtime } from "../runtime"

const CORE_REPO_ROOT = path.join(os.homedir(), ".zenbu", "plugins", "zenbu")

export type UpdateStatus =
  | { kind: "not-a-repo" }
  | { kind: "no-remote" }
  | { kind: "detached-head" }
  | { kind: "git-missing" }
  | { kind: "fetch-error"; message: string }
  | {
      kind: "ok"
      branch: string
      ahead: number
      behind: number
      dirty: boolean
      mergeable: boolean | null
      conflictingFiles: string[]
      head: Commit
      upstream: Commit
      commits: Commit[]
      checkedAt: number
    }

const CACHE_TTL_MS = 5 * 60 * 1000

export type GitOverview =
  | { kind: "not-a-repo" }
  | { kind: "git-missing" }
  | { kind: "error"; message: string }
  | {
      kind: "ok"
      root: string
      branch: string | null
      remote: string | null
      remoteHost: string | null
      remoteOwner: string | null
      remoteRepo: string | null
      remoteWebUrl: string | null
      status: WorkingTreeStatus
      branches: Branch[]
      worktrees: Worktree[]
      log: Commit[]
    }

export type MutationResult =
  | { ok: true; sha?: string; message?: string; url?: string }
  | { ok: false; error: string }

export class GitUpdatesService extends Service {
  static key = "gitUpdates"
  static deps = {}

  private cache: UpdateStatus | null = null
  private cacheAt = 0
  private inFlight: Promise<UpdateStatus> | null = null

  evaluate() {
    this.cache = null
    this.cacheAt = 0
    this.inFlight = null
  }

  async getCachedStatus(): Promise<UpdateStatus | null> {
    return this.cache
  }

  async getOverview(): Promise<GitOverview> {
    const cwd = CORE_REPO_ROOT
    try {
      if (!(await isRepo(cwd))) return { kind: "not-a-repo" }
      const branch = await getBranch(cwd)
      const remote = await getRemoteUrl(cwd)
      const [status, branches, worktrees, log] = await Promise.all([
        getStatus(cwd),
        getBranches(cwd),
        getWorktrees(cwd),
        getLog(cwd, { limit: 20 }),
      ])
      const remoteInfo = remote ? parseRemoteUrl(remote) : null
      return {
        kind: "ok",
        root: cwd,
        branch,
        remote,
        remoteHost: remoteInfo?.host ?? null,
        remoteOwner: remoteInfo?.owner ?? null,
        remoteRepo: remoteInfo?.repo ?? null,
        remoteWebUrl: remoteInfo?.webUrl ?? null,
        status,
        branches,
        worktrees,
        log,
      }
    } catch (err) {
      if (err instanceof GitMissingError) return { kind: "git-missing" }
      const message = err instanceof Error ? err.message : String(err)
      return { kind: "error", message }
    }
  }

  async checkUpdates(force?: boolean): Promise<UpdateStatus> {
    const now = Date.now()
    if (!force && this.cache && now - this.cacheAt < CACHE_TTL_MS) {
      return this.cache
    }
    if (this.inFlight) return this.inFlight

    this.inFlight = this._runCheck().then((status) => {
      this.cache = status
      this.cacheAt = Date.now()
      return status
    }).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async _runCheck(): Promise<UpdateStatus> {
    const cwd = CORE_REPO_ROOT

    try {
      if (!(await isRepo(cwd))) return { kind: "not-a-repo" }

      const branch = await getBranch(cwd)
      if (!branch) return { kind: "detached-head" }

      const remote = await getRemoteUrl(cwd)
      if (!remote) return { kind: "no-remote" }

      const shallow = await isShallow(cwd)
      try {
        await gitFetch(cwd, {
          remote: "origin",
          branch,
          deepen: shallow ? 50 : undefined,
        })
      } catch (err) {
        if (err instanceof GitCommandError) {
          return { kind: "fetch-error", message: err.stderr.trim() || err.message }
        }
        throw err
      }

      const status = await getStatus(cwd)
      const dirty =
        status.staged.length > 0 ||
        status.unstaged.length > 0 ||
        status.conflicted.length > 0 ||
        status.untracked.length > 0

      const headSha = await resolveRef(cwd, "HEAD")
      const upstreamSha = await resolveRef(cwd, "FETCH_HEAD")
      const [head, upstream] = await Promise.all([
        getCommit(cwd, headSha),
        getCommit(cwd, upstreamSha),
      ])

      const { ahead, behind } = await getAheadBehind(cwd, "HEAD", "FETCH_HEAD")

      const [headLog, upstreamLog] = await Promise.all([
        getLog(cwd, { ref: headSha, limit: 15 }),
        behind > 0 ? getLog(cwd, { ref: upstreamSha, limit: 15 }) : Promise.resolve<Commit[]>([]),
      ])
      const bySha = new Map<string, Commit>()
      for (const c of upstreamLog) bySha.set(c.sha, c)
      for (const c of headLog) bySha.set(c.sha, c)
      const commits = [...bySha.values()]
        .sort((a, b) => b.authorDate - a.authorDate)
        .slice(0, 15)

      let mergeable: boolean | null = null
      let conflictingFiles: string[] = []
      if (behind > 0) {
        try {
          const result = await checkMerge(cwd, "HEAD", "FETCH_HEAD")
          mergeable = result.clean
          conflictingFiles = result.conflictingFiles
        } catch (err) {
          if (shallow) {
            try {
              await gitFetch(cwd, { remote: "origin", branch, unshallow: true })
              const retried = await checkMerge(cwd, "HEAD", "FETCH_HEAD")
              mergeable = retried.clean
              conflictingFiles = retried.conflictingFiles
            } catch (retryErr) {
              const message = retryErr instanceof Error ? retryErr.message : String(retryErr)
              return { kind: "fetch-error", message }
            }
          } else {
            const message = err instanceof Error ? err.message : String(err)
            return { kind: "fetch-error", message }
          }
        }
      }

      return {
        kind: "ok",
        branch,
        ahead,
        behind,
        dirty,
        mergeable,
        conflictingFiles,
        head,
        upstream,
        commits,
        checkedAt: Date.now(),
      }
    } catch (err) {
      if (err instanceof GitMissingError) return { kind: "git-missing" }
      throw err
    }
  }

  private _invalidateCache() {
    this.cache = null
    this.cacheAt = 0
  }

  async pullUpdates(): Promise<MutationResult> {
    try {
      const branch = await getBranch(CORE_REPO_ROOT)
      if (!branch) return { ok: false, error: "Not on a branch" }
      await gitPull(CORE_REPO_ROOT, { ffOnly: true, remote: "origin", branch })
      this._invalidateCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async commitChanges(opts: { message: string }): Promise<MutationResult> {
    try {
      const msg = opts.message?.trim()
      if (!msg) return { ok: false, error: "Commit message is required" }
      const sha = await gitCommit(CORE_REPO_ROOT, { message: msg, stageAll: true })
      this._invalidateCache()
      return { ok: true, sha }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async checkoutRef(ref: string): Promise<MutationResult> {
    try {
      if (!ref?.trim()) return { ok: false, error: "Ref is required" }
      await gitCheckout(CORE_REPO_ROOT, ref.trim())
      this._invalidateCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async createBranchAndCheckout(opts: { name: string; from?: string }): Promise<MutationResult> {
    try {
      const name = opts.name?.trim()
      if (!name) return { ok: false, error: "Branch name is required" }
      await gitCreateBranch(CORE_REPO_ROOT, name, { checkout: true, from: opts.from })
      this._invalidateCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async deleteBranchByName(name: string, opts: { force?: boolean } = {}): Promise<MutationResult> {
    try {
      if (!name?.trim()) return { ok: false, error: "Branch name is required" }
      await gitDeleteBranch(CORE_REPO_ROOT, name.trim(), opts)
      this._invalidateCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async pushCurrent(opts: { setUpstream?: boolean } = {}): Promise<MutationResult> {
    try {
      const branch = await getBranch(CORE_REPO_ROOT)
      if (!branch) return { ok: false, error: "Not on a branch" }
      await gitPush(CORE_REPO_ROOT, {
        remote: "origin",
        branch,
        setUpstream: opts.setUpstream ?? false,
      })
      this._invalidateCache()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }

  async createPullRequest(opts: {
    branchName: string
    commitMessage?: string
    baseBranch?: string
  }): Promise<MutationResult> {
    const branchName = opts.branchName?.trim()
    if (!branchName) return { ok: false, error: "Branch name is required" }
    const base = opts.baseBranch?.trim() || "main"

    try {
      const remote = await getRemoteUrl(CORE_REPO_ROOT)
      if (!remote) return { ok: false, error: "No remote configured" }
      const remoteInfo = parseRemoteUrl(remote)
      if (!remoteInfo) return { ok: false, error: `Can't parse remote URL: ${remote}` }

      await gitCreateBranch(CORE_REPO_ROOT, branchName, { checkout: true })

      const status = await getStatus(CORE_REPO_ROOT)
      const hasChanges =
        status.staged.length > 0 ||
        status.unstaged.length > 0 ||
        status.untracked.length > 0
      if (hasChanges) {
        const message = opts.commitMessage?.trim()
        if (!message) {
          return { ok: false, error: "Commit message is required when there are uncommitted changes" }
        }
        await gitCommit(CORE_REPO_ROOT, { message, stageAll: true })
      }

      await gitPush(CORE_REPO_ROOT, {
        remote: "origin",
        branch: branchName,
        setUpstream: true,
      })

      this._invalidateCache()
      return { ok: true, url: remoteInfo.prUrl(base, branchName) }
    } catch (err) {
      return { ok: false, error: formatError(err) }
    }
  }
}

function formatError(err: unknown): string {
  if (err instanceof GitCommandError) {
    return err.stderr.trim() || err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

runtime.register(GitUpdatesService, (import.meta as any).hot)
