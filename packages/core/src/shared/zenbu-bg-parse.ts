/**
 * Pure HTML parser + theme picker for `<meta name="zenbu-bg">` tags.
 *
 * Lives in `shared/` so it can be imported from any of the three places
 * that need to compute a window's pre-paint background color:
 *
 *   - `shared/zenbu-bg.ts` (main process; wraps with `nativeTheme`)
 *   - `setup-gate.ts`      (loaded before the runtime exists)
 *   - `launcher.ts`        (bundled standalone; can't import @zenbujs/core)
 *
 * Has zero non-builtin imports so it costs nothing to pull into any of
 * those layers.
 */

export interface ZenbuBgEntry {
  color: string
  /** Raw `media` attribute value, or `null` for the unconditional default. */
  media: string | null
}

const META_TAG_RE = /<meta\b([^>]*?)\/?>/gi
const ATTR_RE = /([\w-]+)\s*=\s*["']([^"']+)["']/g

/**
 * Parse all `<meta name="zenbu-bg">` tags from `html`. Mirrors the W3C
 * `<meta name="theme-color">` pattern: multiple tags carry a `media`
 * attribute (typically `(prefers-color-scheme: light|dark)`), and an
 * unmediated tag acts as the fallback.
 *
 *   <meta name="zenbu-bg" content="#fafafa" media="(prefers-color-scheme: light)">
 *   <meta name="zenbu-bg" content="#09090b" media="(prefers-color-scheme: dark)">
 *   <meta name="zenbu-bg" content="#27272a">  <!-- default -->
 */
export function parseZenbuBgEntries(html: string): ZenbuBgEntry[] {
  const out: ZenbuBgEntry[] = []
  for (const tag of html.matchAll(META_TAG_RE)) {
    const body = tag[1] ?? ""
    const attrs: Record<string, string> = {}
    for (const a of body.matchAll(ATTR_RE)) {
      attrs[a[1]!.toLowerCase()] = a[2]!
    }
    if (attrs.name === "zenbu-bg" && attrs.content) {
      out.push({ color: attrs.content, media: attrs.media ?? null })
    }
  }
  return out
}

/**
 * Pick the right entry given the current dark-mode preference. Search
 * order:
 *   1. First entry whose `media` matches `(prefers-color-scheme: <dark|light>)`.
 *   2. First entry without a `media` attribute (the unconditional default).
 *   3. The first entry, regardless of `media`.
 *
 * Returns `null` only when `entries` is empty.
 */
export function pickZenbuBgEntry(
  entries: ZenbuBgEntry[],
  dark: boolean,
): string | null {
  for (const e of entries) {
    if (!e.media) continue
    if (dark && /prefers-color-scheme:\s*dark/i.test(e.media)) return e.color
    if (!dark && /prefers-color-scheme:\s*light/i.test(e.media)) return e.color
  }
  for (const e of entries) if (!e.media) return e.color
  return entries[0]?.color ?? null
}
