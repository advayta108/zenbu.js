import path from "node:path"
import { gitOrThrow } from "./runner"

export async function stageAll(cwd: string): Promise<void> {
  await gitOrThrow(cwd, ["add", "-A"])
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitOrThrow(cwd, ["add", "--", ...paths])
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitOrThrow(cwd, ["reset", "HEAD", "--", ...paths])
}

export async function discard(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitOrThrow(cwd, ["checkout", "--", ...paths])
}

export type CommitOptions = {
  message: string
  stageAll?: boolean
  allowEmpty?: boolean
}

export async function commit(cwd: string, opts: CommitOptions): Promise<string> {
  if (opts.stageAll) await stageAll(cwd)
  const args = ["commit", "-m", opts.message]
  if (opts.allowEmpty) args.push("--allow-empty")
  await gitOrThrow(cwd, args)
  const sha = await gitOrThrow(cwd, ["rev-parse", "HEAD"])
  return sha.trim()
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await gitOrThrow(cwd, ["checkout", ref])
}

export type CreateBranchOptions = {
  checkout?: boolean
  from?: string
}

export async function createBranch(
  cwd: string,
  name: string,
  opts: CreateBranchOptions = {},
): Promise<void> {
  if (opts.checkout) {
    const args = ["checkout", "-b", name]
    if (opts.from) args.push(opts.from)
    await gitOrThrow(cwd, args)
  } else {
    const args = ["branch", name]
    if (opts.from) args.push(opts.from)
    await gitOrThrow(cwd, args)
  }
}

export async function deleteBranch(
  cwd: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await gitOrThrow(cwd, ["branch", opts.force ? "-D" : "-d", name])
}

export type PushOptions = {
  remote?: string
  branch?: string
  setUpstream?: boolean
  forceWithLease?: boolean
}

export async function push(cwd: string, opts: PushOptions = {}): Promise<void> {
  const args = ["push"]
  if (opts.setUpstream) args.push("-u")
  if (opts.forceWithLease) args.push("--force-with-lease")
  if (opts.remote) args.push(opts.remote)
  if (opts.branch) args.push(opts.branch)
  await gitOrThrow(cwd, args)
}

export type PullOptions = {
  remote?: string
  branch?: string
  ffOnly?: boolean
  rebase?: boolean
}

export async function pull(cwd: string, opts: PullOptions = {}): Promise<void> {
  const args = ["pull"]
  if (opts.ffOnly) args.push("--ff-only")
  if (opts.rebase) args.push("--rebase")
  if (opts.remote) args.push(opts.remote)
  if (opts.branch) args.push(opts.branch)
  await gitOrThrow(cwd, args)
}

export type CloneOptions = {
  depth?: number
  branch?: string
}

export async function clone(
  url: string,
  destination: string,
  opts: CloneOptions = {},
): Promise<void> {
  const args = ["clone"]
  if (opts.depth) args.push(`--depth=${opts.depth}`)
  if (opts.branch) args.push("-b", opts.branch)
  args.push("--", url, destination)
  const parent = path.dirname(destination)
  await gitOrThrow(parent || ".", args)
}

export async function stash(cwd: string, message?: string): Promise<void> {
  const args = ["stash", "push"]
  if (message) args.push("-m", message)
  await gitOrThrow(cwd, args)
}

export async function stashPop(cwd: string): Promise<void> {
  await gitOrThrow(cwd, ["stash", "pop"])
}
