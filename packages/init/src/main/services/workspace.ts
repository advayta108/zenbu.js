import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { nanoid } from "nanoid"
import * as Effect from "effect/Effect"
import { subscribe, type AsyncSubscription } from "@parcel/watcher"
import { Service, runtime } from "../runtime"
import { DbService } from "./db"
import { WorkspaceContextService } from "./workspace-context"
import { makeWorkspaceAppState } from "../../../shared/agent-ops"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIGURATIONS_DIR = path.resolve(__dirname, "../../../../../configurations")

function parseJsonc(str: string): unknown {
  let result = ""
  let i = 0
  while (i < str.length) {
    if (str[i] === '"') {
      let j = i + 1
      while (j < str.length) {
        if (str[j] === "\\") { j += 2 }
        else if (str[j] === '"') { j++; break }
        else { j++ }
      }
      result += str.slice(i, j)
      i = j
    } else if (str[i] === "/" && str[i + 1] === "/") {
      i += 2
      while (i < str.length && str[i] !== "\n") i++
    } else if (str[i] === "/" && str[i + 1] === "*") {
      i += 2
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++
      i += 2
    } else {
      result += str[i]
      i++
    }
  }
  return JSON.parse(result.replace(/,\s*([\]}])/g, "$1"))
}

async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p)
    return stat.isFile()
  } catch {
    return false
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function resolveWorkspaceConfigPath(zenbuDir: string): Promise<string | null> {
  const jsonc = path.join(zenbuDir, "config.jsonc")
  if (await isFile(jsonc)) return jsonc
  const json = path.join(zenbuDir, "config.json")
  if (await isFile(json)) return json
  return null
}

export class WorkspaceService extends Service {
  static key = "workspace"
  static deps = { db: DbService }
  declare ctx: { db: DbService }

  private loadedWorkspacePlugins = new Map<string, string[]>()

  /**
   * Look up a workspace whose `cwds` already cover `absCwd`. Exact-match on
   * any cwd wins outright; otherwise the workspace owning the longest
   * ancestor of `absCwd` wins. If nothing matches, a new workspace is
   * created with `name = basename(absCwd)`.
   */
  async findOrCreateWorkspaceForCwd(
    absCwd: string,
  ): Promise<{ id: string; created: boolean }> {
    const root = this.ctx.db.client.readRoot()
    const workspaces = root.plugin.kernel.workspaces ?? []

    const exact = workspaces.find((w) => w.cwds.includes(absCwd))
    if (exact) return { id: exact.id, created: false }

    let bestId: string | undefined
    let bestLen = -1
    for (const ws of workspaces) {
      for (const c of ws.cwds) {
        if (absCwd === c || absCwd.startsWith(c + path.sep)) {
          if (c.length > bestLen) {
            bestLen = c.length
            bestId = ws.id
          }
        }
      }
    }
    if (bestId) return { id: bestId, created: false }

    const name = path.basename(absCwd) || absCwd
    const created = await this.createWorkspace(name, [absCwd])
    return { id: created.id, created: true }
  }

  async createWorkspace(
    name: string,
    cwds: string[],
    configId?: string,
  ): Promise<{ id: string }> {
    const id = nanoid()
    const now = Date.now()
    const client = this.ctx.db.effectClient
    await Effect.runPromise(
      client.update((root) => {
        root.plugin.kernel.workspaces = [
          ...(root.plugin.kernel.workspaces ?? []),
          { id, name, cwds, createdAt: now, icon: null },
        ]
      }),
    )
    console.log(`[workspace] created "${name}" (${id}) with ${cwds.length} cwd(s)`)
    if (configId && configId !== "blank") {
      for (const cwd of cwds) {
        await this.applyConfiguration(configId, cwd)
      }
    }
    this.ensureWorkspaceIcon(id).catch(() => {})
    await this.loadWorkspacePlugins(id, cwds)
    return { id }
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.stopWorkspacePlugins(id)
    const client = this.ctx.db.effectClient
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel
        k.workspaces = k.workspaces.filter((w) => w.id !== id)
        // Clear `activeWorkspaceId` from any window that pointed here.
        const nextWindowState: typeof k.windowState = {}
        for (const wid of Object.keys(k.windowState)) {
          const ws = k.windowState[wid]
          nextWindowState[wid] =
            ws.activeWorkspaceId === id
              ? { ...ws, activeWorkspaceId: null }
              : ws
        }
        k.windowState = nextWindowState
        // Drop the workspaceState row.
        const nextWorkspaceState = { ...k.workspaceState }
        delete nextWorkspaceState[id]
        k.workspaceState = nextWorkspaceState
      }),
    )
    console.log(`[workspace] deleted ${id}`)
  }

  async updateWorkspace(
    id: string,
    updates: { name?: string; cwds?: string[] },
  ): Promise<void> {
    const client = this.ctx.db.effectClient
    await Effect.runPromise(
      client.update((root) => {
        const ws = (root.plugin.kernel.workspaces ?? []).find(
          (w) => w.id === id,
        )
        if (!ws) return
        if (updates.name !== undefined) ws.name = updates.name
        if (updates.cwds !== undefined) ws.cwds = updates.cwds
      }),
    )
  }

  async activateWorkspace(
    windowId: string,
    workspaceId: string,
  ): Promise<void> {
    const client = this.ctx.db.effectClient
    const root = this.ctx.db.client.readRoot()
    const prevId =
      root.plugin.kernel.windowState[windowId]?.activeWorkspaceId ?? null

    if (prevId && prevId !== workspaceId) {
      const prevCtx = this.getWorkspaceContext(prevId)
      if (prevCtx) {
        await prevCtx.fireDeactivated(windowId)
      }
    }

    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel
        const ws = k.windowState[windowId]
        if (!ws) return

        // Persist last-active-view for the previous workspace, so re-entry
        // restores it.
        if (prevId && ws.activeViewId) {
          const prevState = k.workspaceState[prevId]
          const base = prevState ?? makeWorkspaceAppState(prevId)
          k.workspaceState = {
            ...k.workspaceState,
            [prevId]: { ...base, lastViewId: ws.activeViewId },
          }
        }

        // Switch the window to the new workspace.
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeWorkspaceId: workspaceId },
        }

        // Pick the active view: either the last view we left this
        // workspace on, or the most-recent chat view bound to this
        // workspace, otherwise the first view in this window.
        const viewMatchesWorkspace = (viewId: string): boolean => {
          const view = k.views.find((v) => v.id === viewId)
          if (!view) return false
          if (view.windowId !== windowId) return false
          if (view.scope !== "chat") return false
          const agentId = view.props.agentId
          if (!agentId) return false
          const bound = k.agentState[agentId]?.workspaceId ?? null
          // Unbound agents (legacy / warm-pool) are visible everywhere;
          // bound agents only match their own workspace.
          return bound === null || bound === workspaceId
        }

        const lastViewId = k.workspaceState[workspaceId]?.lastViewId ?? null

        let target: string | undefined
        if (lastViewId && viewMatchesWorkspace(lastViewId)) {
          target = lastViewId
        } else {
          // Find the most-recent chat view in this window matching workspace,
          // ordered by viewState.order descending.
          const candidates = k.views
            .filter((v) => v.windowId === windowId && viewMatchesWorkspace(v.id))
            .sort(
              (a, b) =>
                (k.viewState[b.id]?.order ?? 0) -
                (k.viewState[a.id]?.order ?? 0),
            )
          target = candidates[0]?.id
        }

        if (target && target !== ws.activeViewId) {
          k.windowState = {
            ...k.windowState,
            [windowId]: {
              ...k.windowState[windowId],
              activeViewId: target,
            },
          }
        }
      }),
    )

    await this.loadWorkspacePlugins(workspaceId,
      (root.plugin.kernel.workspaces ?? []).find((w) => w.id === workspaceId)?.cwds ?? [],
    )

    const newCtx = this.getWorkspaceContext(workspaceId)
    if (newCtx) {
      await newCtx.fireActivated(windowId)
    }

    console.log(
      `[workspace] activated ${workspaceId} in window ${windowId}`,
    )
  }

  async deactivateWorkspace(windowId: string): Promise<void> {
    const root = this.ctx.db.client.readRoot()
    const prevId =
      root.plugin.kernel.windowState[windowId]?.activeWorkspaceId ?? null

    if (prevId) {
      const prevCtx = this.getWorkspaceContext(prevId)
      if (prevCtx) {
        await prevCtx.fireDeactivated(windowId)
      }
    }

    const client = this.ctx.db.effectClient
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel
        const ws = k.windowState[windowId]
        if (!ws) return

        // Persist last-active-view before clearing.
        if (prevId && ws.activeViewId) {
          const prevState = k.workspaceState[prevId]
          const base = prevState ?? makeWorkspaceAppState(prevId)
          k.workspaceState = {
            ...k.workspaceState,
            [prevId]: { ...base, lastViewId: ws.activeViewId },
          }
        }

        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeWorkspaceId: null },
        }
      }),
    )
  }

  async scanWorkspacePlugins(cwds: string[]): Promise<string[]> {
    const manifests: string[] = []
    const seen = new Set<string>()
    const push = (p: string) => {
      const abs = path.resolve(p)
      if (!seen.has(abs)) {
        seen.add(abs)
        manifests.push(abs)
      }
    }
    for (const cwd of cwds) {
      const zenbuDir = path.join(cwd, ".zenbu")
      const configPath = await resolveWorkspaceConfigPath(zenbuDir)
      if (!configPath) continue

      try {
        const raw = await fsp.readFile(configPath, "utf8")
        const config = parseJsonc(raw)
        if (!config || typeof config !== "object") continue
        const plugins = (config as any).plugins
        if (!Array.isArray(plugins)) continue
        for (const entry of plugins) {
          if (typeof entry !== "string") continue
          push(path.resolve(zenbuDir, entry))
        }
      } catch {}
    }
    return manifests
  }

  private async loadWorkspacePlugins(
    workspaceId: string,
    cwds: string[],
  ): Promise<void> {
    if (this.loadedWorkspacePlugins.has(workspaceId)) return

    const manifests = await this.scanWorkspacePlugins(cwds)

    await runtime.scopedImport(workspaceId, async () => {
      runtime.register(WorkspaceContextService)
    })
    await runtime.whenIdle()

    const ctxSlot = runtime.getSlot(`workspace-context@@${workspaceId}`)
    if (ctxSlot?.instance) {
      const ctx = ctxSlot.instance as WorkspaceContextService
      ctx.workspaceId = workspaceId
      ctx.cwds = cwds
    }

    if (manifests.length === 0) {
      this.loadedWorkspacePlugins.set(workspaceId, [])
      return
    }

    const loadedKeys: string[] = []
    for (const manifestPath of manifests) {
      try {
        const url = `zenbu:barrel?manifest=${encodeURIComponent(manifestPath)}`
        await runtime.scopedImport(workspaceId, () => import(url))
        console.log(
          `[workspace] loaded plugins from ${manifestPath} for workspace ${workspaceId}`,
        )
      } catch (err) {
        console.error(
          `[workspace] failed to load ${manifestPath}:`,
          err,
        )
      }
    }

    await runtime.whenIdle()
    loadedKeys.push(...manifests)
    this.loadedWorkspacePlugins.set(workspaceId, loadedKeys)
    console.log(
      `[workspace] ${loadedKeys.length} plugin manifest(s) loaded for workspace ${workspaceId}`,
    )
  }

  private async stopWorkspacePlugins(workspaceId: string): Promise<void> {
    const keys = this.loadedWorkspacePlugins.get(workspaceId)
    if (!keys) {
      this.loadedWorkspacePlugins.delete(workspaceId)
      return
    }

    await runtime.unregisterByWorkspace(workspaceId)
    this.loadedWorkspacePlugins.delete(workspaceId)
    console.log(
      `[workspace] stopped ${keys.length} plugin manifest(s) for workspace ${workspaceId}`,
    )
  }

  private getWorkspaceContext(workspaceId: string): WorkspaceContextService | null {
    const slot = runtime.getSlot(`workspace-context@@${workspaceId}`)
    if (slot?.status === "ready" && slot.instance) {
      return slot.instance as WorkspaceContextService
    }
    return null
  }

  async setWorkspaceIcon(
    workspaceId: string,
    blobId: string,
    origin: "override" | "scanned",
    sourcePath: string | null = null,
  ): Promise<void> {
    const client = this.ctx.db.effectClient
    await Effect.runPromise(
      client.update((root) => {
        const ws = (root.plugin.kernel.workspaces ?? []).find(
          (w) => w.id === workspaceId,
        )
        if (!ws) return
        ws.icon = { blobId, origin, sourcePath }
      }),
    )
  }

  async ensureWorkspaceIcon(workspaceId: string): Promise<string | null> {
    const client = this.ctx.db.client
    const root = client.readRoot()
    const ws = (root.plugin.kernel.workspaces ?? []).find(
      (w) => w.id === workspaceId,
    )
    if (!ws) return null
    if (ws.icon?.blobId) return ws.icon.blobId

    for (const cwd of ws.cwds) {
      const hit = await scanIcon(cwd)
      if (!hit) continue
      let data: Uint8Array
      try {
        data = new Uint8Array(await fsp.readFile(hit.path))
      } catch {
        continue
      }
      const blobId = await client.createBlob(data, true)
      await this.setWorkspaceIcon(workspaceId, blobId, "scanned", hit.path)
      return blobId
    }
    return null
  }

  async listConfigurations(): Promise<
    {
      id: string
      name: string
      description: string
      tags: string[]
      thumbnailBase64: string | null
    }[]
  > {
    const results: {
      id: string
      name: string
      description: string
      tags: string[]
      thumbnailBase64: string | null
    }[] = []
    try {
      const entries = await fsp.readdir(CONFIGURATIONS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const metaPath = path.join(CONFIGURATIONS_DIR, entry.name, "meta.json")
        try {
          const raw = await fsp.readFile(metaPath, "utf8")
          const meta = JSON.parse(raw)
          let thumbnailBase64: string | null = null
          if (meta.thumbnail) {
            const thumbPath = path.join(CONFIGURATIONS_DIR, entry.name, meta.thumbnail)
            try {
              const data = await fsp.readFile(thumbPath)
              thumbnailBase64 = `data:image/png;base64,${data.toString("base64")}`
            } catch {}
          }
          results.push({
            id: meta.id ?? entry.name,
            name: meta.name ?? entry.name,
            description: meta.description ?? "",
            tags: meta.tags ?? [],
            thumbnailBase64,
          })
        } catch {}
      }
    } catch (err) {
      console.error("[workspace] failed to list configurations:", err)
    }
    return results
  }

  async applyConfiguration(configId: string, targetCwd: string): Promise<boolean> {
    const srcZenbu = path.join(CONFIGURATIONS_DIR, configId, ".zenbu")
    const destZenbu = path.join(targetCwd, ".zenbu")
    try {
      if (!(await pathExists(srcZenbu))) {
        console.log(`[workspace] configuration "${configId}" has no .zenbu/ directory, skipping`)
        return false
      }
      await fsp.cp(srcZenbu, destZenbu, { recursive: true })
      console.log(`[workspace] applied configuration "${configId}" to ${targetCwd}`)
      const destPkg = path.join(destZenbu, "package.json")
      if (await pathExists(destPkg)) {
        try {
          await runPnpmInstall(destZenbu)
          console.log(`[workspace] installed deps for configuration "${configId}"`)
        } catch (installErr) {
          console.error(`[workspace] dep install failed for "${configId}":`, installErr)
        }
      }
      return true
    } catch (err) {
      console.error(`[workspace] failed to apply configuration "${configId}":`, err)
      return false
    }
  }

  evaluate() {
    // Eager-load every workspace's plugins on startup. No cleanup hook here:
    // workspace plugins HMR independently through dynohot, so bouncing them
    // when `workspace.ts` itself reloads is unnecessary. It was also unsafe:
    // dynohot Phase 1 (cleanup) runs before Phase 2 (re-eval), so any new or
    // renamed `ServiceRuntime` method called from this cleanup hits the OLD
    // prototype on the live `runtime` singleton (its `setPrototypeOf` rebind
    // happens in Phase 2). `loadedWorkspacePlugins` survives across reload
    // and `loadWorkspacePlugins`'s idempotency guard short-circuits the next
    // evaluate. Explicit eviction is owned by `deleteWorkspace`.
    this.setup("workspace-plugins", () => {
      const root = this.ctx.db.client.readRoot()
      const workspaces = root.plugin.kernel.workspaces ?? []
      for (const ws of workspaces) {
        this.loadWorkspacePlugins(ws.id, ws.cwds).catch((err) => {
          console.error(`[workspace] eager load failed for ${ws.id}:`, err)
        })
      }
    })

    this.setup("workspace-watchers", () => {
      const subscriptions: AsyncSubscription[] = []
      const debouncers = new Map<string, ReturnType<typeof setTimeout>>()
      const root = this.ctx.db.client.readRoot()
      const workspaces = root.plugin.kernel.workspaces ?? []

      const scheduleHotLoad = (workspaceId: string, cwds: string[]) => {
        const existing = debouncers.get(workspaceId)
        if (existing) clearTimeout(existing)
        debouncers.set(
          workspaceId,
          setTimeout(() => {
            debouncers.delete(workspaceId)
            this.maybeHotLoadPlugins(workspaceId, cwds).catch((err) => {
              console.error(`[workspace] hot-load failed for ${workspaceId}:`, err)
            })
          }, 100),
        )
      }

      for (const ws of workspaces) {
        for (const cwd of ws.cwds) {
          const zenbuDir = path.join(cwd, ".zenbu")
          subscribe(cwd, (err, events) => {
            if (err) return
            const touched = events.some(
              (e) => e.path === zenbuDir || e.path.startsWith(zenbuDir + path.sep),
            )
            if (!touched) return
            scheduleHotLoad(ws.id, ws.cwds)
          })
            .then((sub) => {
              subscriptions.push(sub)
            })
            .catch((watchErr) => {
              console.error(`[workspace] watcher setup failed for ${cwd}:`, watchErr)
            })
        }
      }

      return async () => {
        for (const t of debouncers.values()) clearTimeout(t)
        debouncers.clear()
        await Promise.allSettled(subscriptions.map((s) => s.unsubscribe()))
      }
    })
  }

  private async maybeHotLoadPlugins(workspaceId: string, cwds: string[]): Promise<void> {
    const prev = this.loadedWorkspacePlugins.get(workspaceId)
    if (prev && prev.length > 0) return
    const manifests = await this.scanWorkspacePlugins(cwds)
    if (manifests.length === 0) return
    this.loadedWorkspacePlugins.delete(workspaceId)
    await this.loadWorkspacePlugins(workspaceId, cwds)
  }
}

function runPnpmInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["install"], { cwd, stdio: "pipe", timeout: 30_000 })
    let stderrBuf = ""
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm install exited ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ""}`))
    })
  })
}

const ICON_CANDIDATES = [
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "public/icon.svg",
  "public/logo.svg",
  "public/icon.png",
  "public/logo.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "static/icon.svg",
  "static/logo.svg",
  "static/icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "build/icon.png",
  "build/icons/icon.png",
  "icon.svg",
  "icon.png",
  "logo.svg",
  "logo.png",
  "favicon.svg",
  "favicon.ico",
]

async function scanIcon(cwd: string): Promise<{ path: string } | null> {
  for (const rel of ICON_CANDIDATES) {
    const abs = path.join(cwd, rel)
    if (await isFile(abs)) return { path: abs }
  }
  return null
}

runtime.register(WorkspaceService, (import.meta as any).hot)
