import { beforeAll, describe, expect, it } from "vitest"
import { seedTestRepo } from "../scripts/seed-test-repo"
import {
  checkMerge,
  getAheadBehind,
  getBranch,
  getBranches,
  getCommit,
  getLog,
  getRemoteUrl,
  getStatus,
  getWorktrees,
  isDirty,
  isRepo,
  isShallow,
  resolveRef,
} from "../src/index"

let REPO: string
let WORKTREE: string

beforeAll(() => {
  const seeded = seedTestRepo("queries")
  REPO = seeded.repo
  WORKTREE = seeded.worktree
})

describe("@zenbu/git", () => {
  it("detects a git repo", async () => {
    expect(await isRepo(REPO)).toBe(true)
  })

  it("reports not-shallow for the seeded repo", async () => {
    expect(await isShallow(REPO)).toBe(false)
  })

  it("returns the current branch", async () => {
    expect(await getBranch(REPO)).toBe("main")
  })

  it("returns the remote URL", async () => {
    const url = await getRemoteUrl(REPO)
    expect(url).toBeTruthy()
    expect(url).toMatch(/remote\.git$/)
  })

  it("resolves HEAD to a full sha", async () => {
    const sha = await resolveRef(REPO, "HEAD")
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("computes ahead/behind against a diverged branch", async () => {
    const result = await getAheadBehind(REPO, "HEAD", "feature/widget")
    expect(result.ahead).toBe(1)
    expect(result.behind).toBe(1)
  })

  it("reports staged, unstaged, and untracked files", async () => {
    const status = await getStatus(REPO)
    expect(status.staged.map((f) => f.path)).toContain("src/c.txt")
    expect(status.unstaged.map((f) => f.path)).toContain("src/a.txt")
    expect(status.untracked).toContain("untracked.txt")
    expect(status.conflicted).toEqual([])
  })

  it("isDirty is true with changes present", async () => {
    expect(await isDirty(REPO)).toBe(true)
  })

  it("parses the current commit", async () => {
    const commit = await getCommit(REPO, "HEAD")
    expect(commit.subject).toMatch(/change b\.txt/)
    expect(commit.authorEmail).toBe("seed@example.com")
    expect(commit.shortSha.length).toBeGreaterThan(0)
  })

  it("returns recent log entries", async () => {
    const log = await getLog(REPO, { limit: 10 })
    expect(log.length).toBeGreaterThanOrEqual(3)
    expect(log[0]!.subject).toMatch(/change b\.txt/)
  })

  it("lists local and remote branches with the current marker", async () => {
    const branches = await getBranches(REPO)
    const main = branches.find((b) => b.name === "main")
    const feature = branches.find((b) => b.name === "feature/widget")
    expect(main?.isCurrent).toBe(true)
    expect(main?.upstream).toBe("origin/main")
    expect(feature?.isCurrent).toBe(false)
    expect(branches.some((b) => b.isRemote)).toBe(true)
  })

  it("lists worktrees including the linked one", async () => {
    const trees = await getWorktrees(REPO)
    const paths = trees.map((t) => t.path)
    expect(paths).toContain(REPO)
    expect(paths).toContain(WORKTREE)
    const linked = trees.find((t) => t.path === WORKTREE)
    expect(linked?.branch).toBe("feature/widget")
  })

  it("detects conflicts via merge-tree", async () => {
    const result = await checkMerge(REPO, "HEAD", "feature/widget")
    expect(result.clean).toBe(false)
    if (!result.clean) {
      expect(result.conflictingFiles).toContain("src/b.txt")
    }
  })

  it("reports a clean merge when one side is ancestor of the other", async () => {
    const result = await checkMerge(REPO, "HEAD~1", "HEAD")
    expect(result.clean).toBe(true)
  })
})
