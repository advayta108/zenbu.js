import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.resolve(__dirname, "..", ".fixtures")
const DEFAULT_NAME = "seed"

function git(cwd: string, args: string[]): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Seed Author",
    GIT_AUTHOR_EMAIL: "seed@example.com",
    GIT_COMMITTER_NAME: "Seed Author",
    GIT_COMMITTER_EMAIL: "seed@example.com",
    GIT_AUTHOR_DATE: process.env.SEED_GIT_DATE ?? "2024-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: process.env.SEED_GIT_DATE ?? "2024-01-01T00:00:00Z",
  }
  const result = spawnSync("git", args, { cwd, env, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
  }
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function resetDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

export function seedTestRepo(
  name = DEFAULT_NAME,
): { repo: string; remote: string; worktree: string } {
  const root = path.join(FIXTURE_ROOT, name)
  const repoDir = path.join(root, "repo")
  const remoteDir = path.join(root, "remote.git")
  const worktreeDir = path.join(root, "worktree")

  resetDir(root)
  fs.mkdirSync(repoDir, { recursive: true })
  fs.mkdirSync(remoteDir, { recursive: true })

  git(remoteDir, ["init", "--bare", "--initial-branch=main"])

  git(repoDir, ["init", "--initial-branch=main"])
  git(repoDir, ["config", "commit.gpgsign", "false"])
  git(repoDir, ["remote", "add", "origin", remoteDir])

  writeFile(path.join(repoDir, "README.md"), "# Seed Repo\n\nLine 1\nLine 2\nLine 3\n")
  writeFile(path.join(repoDir, "src/a.txt"), "alpha\n")
  git(repoDir, ["add", "."])
  git(repoDir, ["commit", "-m", "initial commit"])

  writeFile(path.join(repoDir, "src/b.txt"), "beta\n")
  git(repoDir, ["add", "."])
  git(repoDir, ["commit", "-m", "add b.txt"])

  git(repoDir, ["push", "-u", "origin", "main"])

  git(repoDir, ["checkout", "-b", "feature/widget"])
  writeFile(path.join(repoDir, "src/b.txt"), "beta-from-feature\n")
  git(repoDir, ["add", "."])
  git(repoDir, ["commit", "-m", "feature: change b.txt"])

  git(repoDir, ["checkout", "main"])
  writeFile(path.join(repoDir, "src/b.txt"), "beta-from-main\n")
  git(repoDir, ["add", "."])
  git(repoDir, ["commit", "-m", "main: change b.txt (will conflict with feature)"])

  writeFile(path.join(repoDir, "src/c.txt"), "gamma (staged)\n")
  git(repoDir, ["add", "src/c.txt"])

  writeFile(path.join(repoDir, "src/a.txt"), "alpha changed (unstaged)\n")

  writeFile(path.join(repoDir, "untracked.txt"), "untracked\n")

  git(repoDir, ["worktree", "add", worktreeDir, "feature/widget"])

  return { repo: repoDir, remote: remoteDir, worktree: worktreeDir }
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "")

if (isDirectInvocation) {
  const { repo, remote, worktree } = seedTestRepo()
  console.log(`Seeded test repo at: ${repo}`)
  console.log(`  remote:   ${remote}`)
  console.log(`  worktree: ${worktree}`)
}
