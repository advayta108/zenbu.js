import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { GitCommandError, GitMissingError } from "./types"

export type GitResult = { code: number; stdout: string; stderr: string }

function zenbuCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "Zenbu")
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Zenbu",
    )
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "Zenbu")
}

function managedGitPath(): string {
  const gitPath = path.join(zenbuCacheRoot(), "bin", "git")
  if (!fs.existsSync(gitPath)) throw new GitMissingError()
  return gitPath
}

export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(managedGitPath(), args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
      })
    } catch (err: any) {
      if (err?.code === "ENOENT") return reject(new GitMissingError())
      return reject(err)
    }

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
    proc.on("error", (err: any) => {
      if (err?.code === "ENOENT") reject(new GitMissingError())
      else reject(err)
    })
    proc.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.code !== 0) {
    throw new GitCommandError(args, result.code, result.stderr)
  }
  return result.stdout
}
