import fs from "node:fs"
import path from "node:path"
import { nativeTheme } from "electron"
import { getAppEntrypoint } from "../runtime"
import {
  parseZenbuBgEntries,
  pickZenbuBgEntry,
} from "./zenbu-bg-parse"

/**
 * Read the `<meta name="zenbu-bg">` color from an HTML file, picking
 * the variant that matches the current system theme
 * (`nativeTheme.shouldUseDarkColors`).
 *
 * Multiple tags with `media="(prefers-color-scheme: light|dark)"` are
 * supported (mirrors the W3C `<meta name="theme-color">` pattern). A
 * tag without `media` is the unconditional fallback.
 *
 * This convention exists because Electron paints a `BaseWindow`'s
 * `backgroundColor` for the brief window between the window appearing
 * on screen and the `WebContentsView`'s first frame reaching the
 * compositor — and similarly the view itself flashes its
 * `setBackgroundColor` before any HTML renders. Reading the meta from
 * the same HTML the renderer will paint keeps both colors in sync with
 * whatever theme the renderer is committing to, so the user never sees
 * a single mismatched frame on window open.
 */
export function readZenbuBgColor(
  htmlPath: string,
  fallback = "#F4F4F4",
): string {
  try {
    const html = fs.readFileSync(htmlPath, "utf8")
    const entries = parseZenbuBgEntries(html)
    const picked = pickZenbuBgEntry(entries, nativeTheme.shouldUseDarkColors)
    if (picked) return picked
  } catch {}
  return fallback
}

/**
 * Resolve the renderer entrypoint's `zenbu-bg` color via the global
 * plugin registry. Convenience wrapper: services creating windows
 * post-boot don't need to plumb the entrypoint path through —
 * `getAppEntrypoint()` returns whatever was published by the loader's
 * registry-setup module at import time.
 *
 * Returns `fallback` if the registry hasn't been populated yet (i.e.
 * pre-loader code paths) or if the entrypoint dir has no `index.html`
 * with a `zenbu-bg` meta tag.
 */
export function entrypointBgColor(fallback = "#F4F4F4"): string {
  const entrypoint = getAppEntrypoint()
  if (!entrypoint) return fallback
  return readZenbuBgColor(path.join(entrypoint, "index.html"), fallback)
}
