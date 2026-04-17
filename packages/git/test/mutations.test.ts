import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { seedTestRepo } from "../scripts/seed-test-repo"
import {
  checkout,
  clone,
  commit,
  createBranch,
  deleteBranch,
  discard,
  getBranch,
  getBranches,
  getCommit,
  getLog,
  getStatus,
  parseRemoteUrl,
  push,
  stageAll,
  unstage,
} from "../src/index"

let REPO: string

beforeEach(() => {
  const seeded = seedTestRepo("mutations")
  REPO = seeded.repo
})

describe("mutations", () => {
  it("stages, commits, and pushes changes", async () => {
    const messageBefore = (await getCommit(REPO, "HEAD")).subject
    await stageAll(REPO)
    const sha = await commit(REPO, { message: "seed mutations: snapshot" })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const head = await getCommit(REPO, "HEAD")
    expect(head.subject).toBe("seed mutations: snapshot")
    expect(head.subject).not.toBe(messageBefore)

    await push(REPO, { remote: "origin", branch: "main" })
  })

  it("checks out existing branches", async () => {
    await stageAll(REPO)
    await commit(REPO, { message: "snapshot for checkout" })
    await createBranch(REPO, "scratch")
    await checkout(REPO, "scratch")
    expect(await getBranch(REPO)).toBe("scratch")
  })

  it("creates a new branch from a ref and checks it out", async () => {
    await stageAll(REPO)
    await commit(REPO, { message: "snapshot" })
    await createBranch(REPO, "proposal/x", { checkout: true, from: "main" })
    expect(await getBranch(REPO)).toBe("proposal/x")
    const branches = await getBranches(REPO)
    expect(branches.some((b) => b.name === "proposal/x")).toBe(true)
  })

  it("deletes a branch", async () => {
    await stageAll(REPO)
    await commit(REPO, { message: "snapshot" })
    await createBranch(REPO, "throwaway")
    await deleteBranch(REPO, "throwaway")
    const branches = await getBranches(REPO)
    expect(branches.some((b) => b.name === "throwaway")).toBe(false)
  })

  it("unstage moves files back to unstaged", async () => {
    const before = await getStatus(REPO)
    expect(before.staged.map((f) => f.path)).toContain("src/c.txt")
    await unstage(REPO, ["src/c.txt"])
    const after = await getStatus(REPO)
    expect(after.staged.map((f) => f.path)).not.toContain("src/c.txt")
  })

  it("discard restores an unstaged file to HEAD", async () => {
    const before = await getStatus(REPO)
    expect(before.unstaged.map((f) => f.path)).toContain("src/a.txt")
    await discard(REPO, ["src/a.txt"])
    const after = await getStatus(REPO)
    expect(after.unstaged.map((f) => f.path)).not.toContain("src/a.txt")
  })

  it("clones from a local remote into a new destination", async () => {
    const dest = path.join(REPO, "..", "cloned")
    await clone(`file://${path.join(REPO, "..", "remote.git")}`, dest)
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true)
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true)
  })

  it("end-to-end PR flow: branch + commit + push", async () => {
    await createBranch(REPO, "feature/proposal", { checkout: true })
    await stageAll(REPO)
    await commit(REPO, { message: "propose a change" })
    await push(REPO, {
      remote: "origin",
      branch: "feature/proposal",
      setUpstream: true,
    })
    const log = await getLog(REPO, { ref: "feature/proposal", limit: 3 })
    expect(log[0]!.subject).toBe("propose a change")
  })
})

describe("parseRemoteUrl", () => {
  it("parses ssh URLs", () => {
    const info = parseRemoteUrl("git@github.com:zenbu-labs/zenbu.git")
    expect(info?.host).toBe("github.com")
    expect(info?.owner).toBe("zenbu-labs")
    expect(info?.repo).toBe("zenbu")
    expect(info?.webUrl).toBe("https://github.com/zenbu-labs/zenbu")
    expect(info?.compareUrl("main", "feature/x")).toBe(
      "https://github.com/zenbu-labs/zenbu/compare/main...feature%2Fx",
    )
  })

  it("parses https URLs", () => {
    const info = parseRemoteUrl("https://github.com/owner/repo.git")
    expect(info?.owner).toBe("owner")
    expect(info?.repo).toBe("repo")
  })

  it("handles URLs without .git suffix", () => {
    const info = parseRemoteUrl("https://gitlab.example.com/group/project")
    expect(info?.host).toBe("gitlab.example.com")
    expect(info?.owner).toBe("group")
    expect(info?.repo).toBe("project")
  })

  it("returns null for unrecognised URLs", () => {
    expect(parseRemoteUrl("not-a-url")).toBeNull()
    expect(parseRemoteUrl("")).toBeNull()
  })
})
