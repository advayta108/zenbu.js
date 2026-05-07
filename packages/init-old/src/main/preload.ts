import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Preload for the `kernel` plugin.
 *
 * Runs concurrently with plugin-import via the kernel shell's preload
 * mechanism (see `apps/kernel/src/shell/index.ts`). The result is accessible
 * in-process via `getPreload("kernel")` from `./preload-get.ts`.
 *
 * The motivating use case is discovering the user's login-shell `$PATH` so
 * services that spawn user-installed binaries (Claude, codex, etc.) can find
 * them. GUI-launched Electron inherits launchd's minimal PATH and therefore
 * misses anything the user set in `~/.zshrc`.
 *
 * IMPORTANT: uses the ASYNC `execFile` (not `execFileSync`). The shell
 * subprocess runs ~800ms (zsh reading rc files, loading oh-my-zsh, nvm
 * init, etc.) — that work happens on the OS, not our event loop. If we
 * used the sync variant, the Node main thread would be blocked the entire
 * time, starving plugin-import of CPU. Async lets the main thread drive
 * module loading while the shell does its thing in a subprocess.
 */
export default async function kernelPreload(): Promise<{
  pathExtras: string[]
}> {
  /**
   * this preload is majorly brain damaged i don't think we need this to find the bin of agents but skill issue for now
   */
  const shell = process.env.SHELL ?? "/bin/zsh"
  try {
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", "echo -n __ZENBU_PATH__$PATH"],
      {
        encoding: "utf8",
        timeout: 3000,
      },
    )
    const marker = "__ZENBU_PATH__"
    const idx = stdout.lastIndexOf(marker)
    if (idx < 0) return { pathExtras: [] }
    return {
      pathExtras: stdout
        .slice(idx + marker.length)
        .trim()
        .split(path.delimiter)
        .filter(Boolean),
    }
  } catch {
    return { pathExtras: [] }
  }
}
