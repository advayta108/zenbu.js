import type { Transform, TransformInput, TransformOutput } from "./build-config"

const STRIP_START = /^\s*\/\/\s*@zenbu:strip-if\s+(!?)([A-Za-z_][A-Za-z0-9_]*)\s*$/
const STRIP_END = /^\s*\/\/\s*@zenbu:end\s*$/

/**
 * Marker-based feature-flag stripping. Removes lines between
 *   // @zenbu:strip-if FLAG       (strip when FLAG is truthy)
 *   // @zenbu:strip-if !FLAG      (strip when FLAG is falsy)
 *   ...
 *   // @zenbu:end
 *
 * Pure string/line ops — no AST, no compiler dep.
 */
export function stripIfDisabled(flags: Record<string, boolean>): Transform {
  return (file: TransformInput): TransformOutput => {
    const lines = file.code.split("\n")
    const out: string[] = []
    let stripDepth = 0

    for (const line of lines) {
      const startMatch = STRIP_START.exec(line)
      if (startMatch) {
        const negated = startMatch[1] === "!"
        const flagName = startMatch[2]!
        const flagValue = flags[flagName] ?? false
        const shouldStrip = negated ? !flagValue : flagValue
        if (shouldStrip || stripDepth > 0) {
          stripDepth += 1
        }
        continue
      }

      if (STRIP_END.test(line)) {
        if (stripDepth > 0) stripDepth -= 1
        continue
      }

      if (stripDepth === 0) out.push(line)
    }

    return { code: out.join("\n") }
  }
}

/**
 * Drop files whose path matches the given pattern (relative path from the
 * source root, posix slashes). Also covered by `ignore` globs in the config;
 * use this when a regex is more convenient than a glob.
 */
export function dropFiles(pattern: RegExp | ((path: string) => boolean)): Transform {
  const test = typeof pattern === "function" ? pattern : (p: string) => pattern.test(p)
  return (file: TransformInput): TransformOutput | undefined => {
    if (test(file.path)) return { drop: true }
    return undefined
  }
}
