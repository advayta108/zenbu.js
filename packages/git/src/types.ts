export type Commit = {
  sha: string
  shortSha: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: number
}

export type FileChange = {
  path: string
  oldPath: string | null
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unknown"
}

export type WorkingTreeStatus = {
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  conflicted: string[]
}

export type Branch = {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream: string | null
  sha: string
}

export type Worktree = {
  path: string
  sha: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
}

export type MergeCheck =
  | { clean: true; conflictingFiles: [] }
  | { clean: false; conflictingFiles: string[] }

export type AheadBehind = { ahead: number; behind: number }

export class GitMissingError extends Error {
  constructor() {
    super("git executable not found on PATH")
    this.name = "GitMissingError"
  }
}

export class GitCommandError extends Error {
  code: number
  args: string[]
  stderr: string
  constructor(args: string[], code: number, stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || "<no stderr>"}`)
    this.name = "GitCommandError"
    this.args = args
    this.code = code
    this.stderr = stderr
  }
}
