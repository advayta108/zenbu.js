import type { Plugin, TransformResult } from "vite"
import { transformSync } from "@babel/core"
import zenbuAdviceTransform from "./transform/index"

export interface ZenbuAdvicePluginOptions {
  root?: string
  include?: RegExp
  exclude?: RegExp
}

const defaultInclude = /\.[jt]sx?$/
// Skip:
//   - node_modules        — third-party code, advice can't target it
//   - .vite/deps          — Vite's default prebundled deps cache
//   - vite-cache/.../deps — Zenbu's relocated Vite cache (under
//                           ~/.zenbu/.internal/vite-cache/<root>/deps/)
// Without the deps-cache excludes, we'd uselessly Babel-transform giant
// prebundled chunks like react-dom_client.js (>500KB) on every dev boot,
// which also makes @babel/generator emit the noisy "code generator has
// deoptimised the styling" note.
const defaultExclude = /node_modules|[/\\]\.vite[/\\]deps[/\\]|[/\\]vite-cache[/\\][^/\\]+[/\\]deps[/\\]/

export function zenbuAdvicePlugin(options: ZenbuAdvicePluginOptions = {}): Plugin {
  let resolvedRoot: string

  return {
    name: "zenbu-advice",
    enforce: "pre",

    configResolved(config) {
      resolvedRoot = options.root ?? config.root
    },

    transform(code, id): TransformResult | null {
      const include = options.include ?? defaultInclude
      const exclude = options.exclude ?? defaultExclude

      if (!include.test(id)) return null
      if (exclude.test(id)) return null
      if (code.includes("applyAdviceChain") || code.includes("__zenbu_def")) return null

      const isTS = /\.tsx?$/.test(id)
      const parserPlugins: string[] = isTS ? ["typescript"] : []
      if (/\.(?:jsx|tsx)$/.test(id)) parserPlugins.push("jsx")

      const result = transformSync(code, {
        filename: id,
        plugins: [[zenbuAdviceTransform, { root: resolvedRoot }]],
        parserOpts: { plugins: parserPlugins as any },
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        // Force a non-"auto" value so @babel/generator never emits the
        // "code generator has deoptimised the styling" note on large
        // inputs. `false` keeps readable output (vs `true`'s minified).
        compact: false,
      })

      if (!result?.code) return null

      return {
        code: result.code,
        map: result.map as any,
      }
    },
  }
}
