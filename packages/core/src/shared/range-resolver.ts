/**
 * Resolves the latest commit on a source-mirror branch whose
 * `package.json#zenbu.host` semver range still satisfies the running
 * .app's `host.json#version`. Pure functions over `isomorphic-git` plus
 * `semver` — no Electron dependency.
 *
 * Imported by both:
 *   - `packages/core/src/launcher.ts` (tsdown inlines this into
 *     `dist/launcher.mjs`; the launcher cannot `import "@zenbujs/core"`)
 *   - `packages/core/src/services/updater.ts` (resolved through normal
 *     `@zenbujs/core/...` resolution at runtime)
 *
 * Algorithm:
 *   1. Hot path — resolve `refs/remotes/origin/<branch>` (caller is
 *      responsible for an upstream-fresh ref; the launcher and updater
 *      both `git.fetch` before invoking us). If the tip's
 *      `package.json#zenbu.host` already satisfies `hostVersion`,
 *      return tip.
 *   2. Cold path — deepen the local shallow history geometrically
 *      (`git.fetch({depth: nextDepth, relative: false})`), running
 *      `git.log({depth: nextDepth})` to enumerate the now-known history.
 *      Lower-bound binary search inside that window for the smallest
 *      index whose commit is compatible — i.e. the LATEST compatible
 *      commit. The search assumes monotonic ranges (newer commits'
 *      `zenbu.host` is equal-or-stricter than older commits'); if a
 *      project violates this, the resolver may pick a slightly older
 *      compatible commit than the absolute latest.
 *   3. If deepen exhausts the branch's history without finding a
 *      compatible commit, return `targetSha: null`. The caller decides
 *      what to do (the launcher errors out; the updater service surfaces
 *      `phase: "incompatible"`).
 */

import * as git from "isomorphic-git"
import semver from "semver"

import type { InstallReporter } from "./pm-install"

export interface RangeResolverInput {
  fs: typeof import("node:fs")
  http: Parameters<typeof git.clone>[0]["http"]
  dir: string
  mirror: { url: string; branch: string }
  /** Concrete semver of the running .app, e.g. "0.0.6". From host.json. */
  hostVersion: string
  reporter?: InstallReporter | null
  signal?: AbortSignal
}

export interface RangeResolverResult {
  /**
   * SHA of the latest commit on origin/<branch> whose
   * `package.json#zenbu.host` satisfies `hostVersion`. `null` when no
   * commit on the branch satisfies the host (the caller should not
   * check anything out and surface an error).
   */
  targetSha: string | null
  /** SHA of `refs/remotes/origin/<branch>` at resolution time. */
  tipSha: string
  /** Number of commits inspected (HEAD + any deepen rounds). */
  consideredCommits: number
  /**
   * True when deepen returned no new commits — i.e. we walked the
   * branch's entire history. Combined with `targetSha === null` this
   * means the mirror has no compatible commit at all.
   */
  exhaustedHistory: boolean
}

const FIRST_DEEPEN_DEPTH = 16
const MAX_DEEPEN_DEPTH = 4096

interface ReadCommitArgs {
  fs: typeof import("node:fs")
  dir: string
  commitOid: string
}

async function readZenbuHostAt(
  args: ReadCommitArgs,
): Promise<{ range: string | null; missing: boolean }> {
  try {
    const { blob } = await git.readBlob({
      fs: args.fs,
      dir: args.dir,
      oid: args.commitOid,
      filepath: "package.json",
    })
    const text = Buffer.from(blob).toString("utf8")
    const parsed = JSON.parse(text) as { zenbu?: { host?: unknown } }
    const raw = parsed.zenbu?.host
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { range: null, missing: true }
    }
    return { range: raw.trim(), missing: false }
  } catch {
    return { range: null, missing: true }
  }
}

function isCompatible(hostVersion: string, range: string | null): boolean {
  // Missing range -> treat as compatible (back-compat for older commits
  // that predate the convention). The launcher and updater can warn but
  // shouldn't refuse to install.
  if (!range) return true
  try {
    return semver.satisfies(hostVersion, range, { includePrerelease: true })
  } catch {
    return false
  }
}

export async function resolveTargetSha(
  input: RangeResolverInput,
): Promise<RangeResolverResult> {
  const { fs, http, dir, mirror, hostVersion, reporter = null, signal } = input

  const remoteRef = `refs/remotes/origin/${mirror.branch}`
  reporter?.step?.("resolve", `Resolving compatible commit (host=${hostVersion})`)

  const tipSha = await git.resolveRef({ fs, dir, ref: remoteRef })

  let consideredCommits = 1
  const tipInfo = await readZenbuHostAt({ fs, dir, commitOid: tipSha })
  if (isCompatible(hostVersion, tipInfo.range)) {
    reporter?.message?.(
      `[resolve] tip ${tipSha.slice(0, 7)} ` +
        (tipInfo.range
          ? `range="${tipInfo.range}" ok for host=${hostVersion}`
          : `no zenbu.host declared; assuming compatible`),
    )
    reporter?.done?.("resolve")
    return {
      targetSha: tipSha,
      tipSha,
      consideredCommits,
      exhaustedHistory: false,
    }
  }

  reporter?.message?.(
    `[resolve] tip ${tipSha.slice(0, 7)} range="${tipInfo.range}" does not ` +
      `satisfy host=${hostVersion}; deepening history...`,
  )

  let depth = FIRST_DEEPEN_DEPTH
  let lastSeen = 1
  let exhausted = false

  while (depth <= MAX_DEEPEN_DEPTH) {
    if (signal?.aborted) throw new Error("resolveTargetSha aborted")
    reporter?.progress?.({
      phase: "resolve",
      loaded: depth,
      total: MAX_DEEPEN_DEPTH,
    })
    try {
      await git.fetch({
        fs,
        http,
        dir,
        url: mirror.url,
        ref: mirror.branch,
        singleBranch: true,
        depth,
        relative: false,
        tags: false,
      })
    } catch (err) {
      reporter?.message?.(
        `[resolve] deepen depth=${depth} failed: ${(err as Error).message}`,
      )
      break
    }

    const log = await git.log({ fs, dir, ref: remoteRef, depth })
    if (log.length <= lastSeen) {
      exhausted = true
      break
    }
    lastSeen = log.length
    consideredCommits = log.length

    const oids = log.map((c) => c.oid)
    // Lower-bound binary search. `isCompatible` is assumed monotonic on
    // the linear branch history (newest at index 0): false at the
    // newest commits, true at the older ones we want. We look for the
    // smallest index k where isCompatible holds.
    let lo = 0
    let hi = oids.length
    while (lo < hi) {
      if (signal?.aborted) throw new Error("resolveTargetSha aborted")
      const mid = (lo + hi) >>> 1
      const info = await readZenbuHostAt({ fs, dir, commitOid: oids[mid]! })
      if (isCompatible(hostVersion, info.range)) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }
    if (lo < oids.length) {
      const targetSha = oids[lo]!
      reporter?.message?.(
        `[resolve] picked ${targetSha.slice(0, 7)} ` +
          `(${oids.length - lo} commits behind tip; ` +
          `host=${hostVersion} ok)`,
      )
      reporter?.done?.("resolve")
      return {
        targetSha,
        tipSha,
        consideredCommits,
        exhaustedHistory: false,
      }
    }
    depth *= 2
  }

  reporter?.message?.(
    `[resolve] no compatible commit found in ${consideredCommits} commits ` +
      `on origin/${mirror.branch} (host=${hostVersion})`,
  )
  reporter?.error?.({
    id: "resolve",
    message:
      `no commit on origin/${mirror.branch} declares zenbu.host that ` +
      `satisfies host=${hostVersion}`,
  })
  return {
    targetSha: null,
    tipSha,
    consideredCommits,
    exhaustedHistory: exhausted,
  }
}
