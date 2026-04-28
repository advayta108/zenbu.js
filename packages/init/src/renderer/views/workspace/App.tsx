import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { nanoid } from "nanoid"
import { makeCollection } from "@zenbu/kyju/schema"
import {
  RpcProvider,
  EventsProvider,
  KyjuClientProvider,
  useWsConnection,
} from "@/lib/ws-connection"
import type { WsConnectionState } from "@/lib/ws-connection"
import { KyjuProvider, useDb } from "@/lib/kyju-react"
import { useKyjuClient, useRpc } from "@/lib/providers"
import { ViewCacheSlot } from "@/lib/view-cache"
import { AgentList } from "@/views/orchestrator/components/AgentList"
import { ActiveView } from "@/views/orchestrator/components/ActiveView"
import {
  insertHotAgent,
  validSelectionFromTemplate,
  makeAgentAppState,
  makeViewAppState,
  type ArchivedAgent,
} from "../../../../shared/agent-ops"
import type { SchemaRoot, View } from "../../../../shared/schema"

type AgentItem = SchemaRoot["agents"][number]
type RegistryEntry = {
  scope: string
  url: string
  port: number
  icon?: string
  workspaceId?: string
  meta?: { kind?: string; sidebar?: boolean }
}

const params = new URLSearchParams(window.location.search)
const wsPort = Number(params.get("wsPort"))
const wsToken = params.get("wsToken") ?? ""
const windowId = params.get("windowId") ?? ""
const workspaceIdParam = params.get("workspaceId") ?? ""
if (!windowId) throw new Error("Missing ?windowId= in workspace URL")
if (!wsToken) throw new Error("Missing ?wsToken= in workspace URL")

// ---- width stores (localStorage-backed) ----

const AGENT_SIDEBAR_STORAGE_KEY = "agent-sidebar:width"
const UTILITY_SIDEBAR_STORAGE_KEY = "utility-sidebar:width"
const AGENT_DEFAULT = 280
const UTIL_DEFAULT = 320

function makeWidthStore(storageKey: string, defaultVal: number) {
  const listeners = new Set<() => void>()
  let memo: number | null = null

  function read(): number {
    if (memo !== null) return memo
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw != null) {
        const n = parseInt(raw, 10)
        if (Number.isFinite(n)) {
          memo = n
          return memo
        }
      }
    } catch {}
    memo = defaultVal
    return memo
  }
  function get(): number { return read() }
  function set(next: number) {
    const rounded = Math.round(next)
    if (rounded === memo) return
    memo = rounded
    try { localStorage.setItem(storageKey, String(rounded)) } catch {}
    for (const l of listeners) l()
  }
  function useWidth(): number {
    return useSyncExternalStore(
      (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
      read,
      read,
    )
  }
  return { get, set, useWidth }
}

const agentWidthStore = makeWidthStore(AGENT_SIDEBAR_STORAGE_KEY, AGENT_DEFAULT)
const utilWidthStore = makeWidthStore(UTILITY_SIDEBAR_STORAGE_KEY, UTIL_DEFAULT)

// ---- main view ----

function WorkspaceContent() {
  const client = useKyjuClient()
  const rpc = useRpc()

  const allViews = useDb((root) => root.plugin.kernel.views) ?? []
  const views = useMemo(
    () =>
      allViews
        .filter((v) => v.windowId === windowId)
        .map((v) => v),
    [allViews],
  )
  const viewState = useDb((root) => root.plugin.kernel.viewState) ?? {}

  const sortedViews = useMemo(
    () =>
      [...views].sort(
        (a, b) =>
          (viewState[a.id]?.order ?? 0) - (viewState[b.id]?.order ?? 0),
      ),
    [views, viewState],
  )

  const agents = useDb((root) => root.plugin.kernel.agents) ?? []

  const registry = useDb((root) => root.plugin.kernel.viewRegistry) ?? []
  const registryMap = useMemo(() => {
    const m = new Map<string, RegistryEntry>()
    for (const e of registry) m.set(e.scope, e)
    return m
  }, [registry])

  const activeViewId = useDb(
    (root) => root.plugin.kernel.windowState[windowId]?.activeViewId ?? null,
  )

  // Per-view sidebar / utility state. Read from the active view's record;
  // defaults if no active view.
  const activeViewState = activeViewId ? viewState[activeViewId] : null
  const sidebarOpen = activeViewState?.sidebarOpen ?? true
  const utilSelected = activeViewState?.utilitySidebarSelected ?? null

  const sidebarEntries = useMemo<RegistryEntry[]>(() => {
    const all = registry.filter((e) => e.meta?.sidebar === true)
    const filtered = all.filter((e) =>
      !e.workspaceId || e.workspaceId === workspaceIdParam,
    )
    return filtered
  }, [registry])
  const selectedUtilEntry = useMemo(
    () => sidebarEntries.find((e) => e.scope === utilSelected),
    [sidebarEntries, utilSelected],
  )

  const updateActiveViewState = useCallback(
    (updater: (cur: SchemaRoot["viewState"][string]) => SchemaRoot["viewState"][string]) => {
      if (!activeViewId) return
      const all = client.plugin.kernel.viewState.read() ?? {}
      const cur = all[activeViewId]
      if (!cur) return
      void client.plugin.kernel.viewState.set({
        ...all,
        [activeViewId]: updater(cur),
      })
    },
    [client, activeViewId],
  )

  // ---- handlers ----

  const seedSidebarFromActive = useCallback(() => {
    const cur = activeViewId ? viewState[activeViewId] : null
    return {
      sidebarOpen: cur?.sidebarOpen ?? false,
      tabSidebarOpen: cur?.tabSidebarOpen ?? true,
      sidebarPanel: cur?.sidebarPanel ?? "overview",
      utilitySidebarSelected: cur?.utilitySidebarSelected ?? null,
    }
  }, [activeViewId, viewState])

  const nextOrder = useCallback((): number => {
    const k = client.readRoot().plugin.kernel
    let max = -1
    for (const v of k.views) {
      if (v.windowId !== windowId) continue
      const o = k.viewState[v.id]?.order ?? 0
      if (o > max) max = o
    }
    return max + 1
  }, [client])

  const activeWorkspaceId = useDb(
    (root) => root.plugin.kernel.windowState[windowId]?.activeWorkspaceId ?? null,
  )

  const handleNewAgent = useCallback(async () => {
    const newViewId = nanoid()
    const order = nextOrder()
    const sidebarSeed = seedSidebarFromActive()
    await client.update((root) => {
      const k = root.plugin.kernel
      k.views = [
        ...k.views,
        {
          id: newViewId,
          windowId,
          parentId: activeViewId ?? null,
          scope: "new-agent",
          params: {},
          createdAt: Date.now(),
        },
      ]
      k.viewState = {
        ...k.viewState,
        [newViewId]: makeViewAppState(newViewId, {
          order,
          ...sidebarSeed,
        }),
      }
      const ws = k.windowState[windowId]
      if (ws) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: newViewId },
        }
      }
    })
  }, [client, nextOrder, seedSidebarFromActive, activeViewId])

  const handleOpenPlugins = useCallback(async () => {
    // Reuse an existing plugins view in this window if one exists, otherwise
    // create a fresh one.
    const existing = sortedViews.find((v) => v.scope === "plugins")
    if (existing) {
      const k = client.readRoot().plugin.kernel
      const ws = k.windowState[windowId]
      if (ws && ws.activeViewId !== existing.id) {
        await client.update((root) => {
          const wss = root.plugin.kernel.windowState[windowId]
          if (!wss) return
          root.plugin.kernel.windowState = {
            ...root.plugin.kernel.windowState,
            [windowId]: { ...wss, activeViewId: existing.id },
          }
        })
      }
      return
    }
    const newViewId = nanoid()
    const order = nextOrder()
    const sidebarSeed = seedSidebarFromActive()
    await client.update((root) => {
      const k = root.plugin.kernel
      k.views = [
        ...k.views,
        {
          id: newViewId,
          windowId,
          parentId: activeViewId ?? null,
          scope: "plugins",
          params: {},
          createdAt: Date.now(),
        },
      ]
      k.viewState = {
        ...k.viewState,
        [newViewId]: makeViewAppState(newViewId, {
          order,
          ...sidebarSeed,
        }),
      }
      const ws = k.windowState[windowId]
      if (ws) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: newViewId },
        }
      }
    })
  }, [client, sortedViews, nextOrder, seedSidebarFromActive, activeViewId])

  const handleSwitchTab = useCallback(
    async (viewId: string) => {
      await client.update((root) => {
        const k = root.plugin.kernel
        const ws = k.windowState[windowId]
        if (!ws) return
        const oldActiveId = ws.activeViewId
        if (oldActiveId === viewId) return
        const now = Date.now()

        // Update unread state on the old active chat view's agent.
        if (oldActiveId) {
          const oldView = k.views.find((v) => v.id === oldActiveId)
          const oldAgentId =
            oldView?.scope === "chat" ? oldView.params.agentId : undefined
          if (oldAgentId) {
            const cur = k.agentState[oldAgentId]
            k.agentState = {
              ...k.agentState,
              [oldAgentId]: cur
                ? { ...cur, lastViewedAt: now }
                : makeAgentAppState(oldAgentId, { lastViewedAt: now }),
            }
          }
        }

        // Clear unread on the newly-active chat view's agent.
        const newView = k.views.find((v) => v.id === viewId)
        const newAgentId =
          newView?.scope === "chat" ? newView.params.agentId : undefined
        if (newAgentId) {
          const cur = k.agentState[newAgentId]
          k.agentState = {
            ...k.agentState,
            [newAgentId]: cur
              ? { ...cur, lastViewedAt: null }
              : makeAgentAppState(newAgentId, { lastViewedAt: null }),
          }
        }

        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: viewId },
        }
      })
    },
    [client],
  )

  const removeView = useCallback(
    async (viewId: string) => {
      await client.update((root) => {
        const k = root.plugin.kernel
        k.views = k.views.filter((v) => v.id !== viewId)
        const nextVS = { ...k.viewState }
        delete nextVS[viewId]
        k.viewState = nextVS
        // If the closed view was active, fall back to the highest-order
        // remaining view in this window (or null).
        const ws = k.windowState[windowId]
        if (ws && ws.activeViewId === viewId) {
          let fallback: string | null = null
          let maxOrder = -1
          for (const v of k.views) {
            if (v.windowId !== windowId) continue
            const o = k.viewState[v.id]?.order ?? 0
            if (o > maxOrder) {
              maxOrder = o
              fallback = v.id
            }
          }
          k.windowState = {
            ...k.windowState,
            [windowId]: { ...ws, activeViewId: fallback },
          }
        }
      })
    },
    [client],
  )

  const handleCloseTab = useCallback(
    async (viewId: string) => {
      const view = views.find((v) => v.id === viewId)
      // Only ask for confirmation if it's a chat view with conversation
      // history; sentinels and empty views close quietly.
      const agentId = view?.scope === "chat" ? view.params.agentId : undefined
      const hasMessages = agentId
        ? (() => {
            const a = client.readRoot().plugin.kernel.agents.find(
              (x) => x.id === agentId,
            )
            return (a?.lastUserMessageAt ?? null) != null
          })()
        : false
      if (hasMessages) {
        const confirmed = await rpc.window.confirm({
          title: "Close chat?",
          message: "You can always re-open this chat later.",
          confirmLabel: "Close",
          windowId,
        })
        if (!confirmed) return
      }
      await removeView(viewId)
    },
    [removeView, rpc, views, client],
  )

  const handleCloseTabQuiet = useCallback(
    async (viewId: string) => {
      await removeView(viewId)
    },
    [removeView],
  )

  const onUtilIconClick = useCallback(
    (scope: string) => {
      const next = scope === utilSelected ? null : scope
      updateActiveViewState((cur) => ({
        ...cur,
        utilitySidebarSelected: next,
      }))
    },
    [updateActiveViewState, utilSelected],
  )

  // Track lastViewId on the workspace whenever the active view changes.
  // Used to restore the last-viewed view when the workspace becomes active
  // again on this (or any) window.
  useEffect(() => {
    if (!activeViewId || !workspaceIdParam) return
    const cur = client.plugin.kernel.workspaceState.read() ?? {}
    const existing = cur[workspaceIdParam]
    if (existing?.lastViewId === activeViewId) return
    void client.plugin.kernel.workspaceState.set({
      ...cur,
      [workspaceIdParam]: existing
        ? { ...existing, lastViewId: activeViewId }
        : { workspaceId: workspaceIdParam, lastViewId: activeViewId },
    })
  }, [activeViewId, client])

  // ---- iframe srcs ----

  const wsParam = workspaceIdParam
    ? `&workspaceId=${encodeURIComponent(workspaceIdParam)}`
    : ""

  const utilPanelVisible = selectedUtilEntry != null
  const utilPanelSrc = useMemo(() => {
    if (!selectedUtilEntry) return ""
    let entryPath = new URL(selectedUtilEntry.url).pathname
    const ownsServer = entryPath === "/" || entryPath === ""
    if (ownsServer) entryPath = ""
    else if (entryPath.endsWith("/")) entryPath = entryPath.slice(0, -1)
    const targetPort = ownsServer ? selectedUtilEntry.port : wsPort
    const raw = `usb-${windowId}-${selectedUtilEntry.scope}`
    const hostname = raw.toLowerCase().replace(/[^a-z0-9]/g, "")
    return `http://${hostname}.localhost:${targetPort}${entryPath}/index.html?wsPort=${wsPort}&wsToken=${encodeURIComponent(
      wsToken,
    )}&windowId=${encodeURIComponent(
      windowId,
    )}&scope=${encodeURIComponent(selectedUtilEntry.scope)}${wsParam}`
  }, [selectedUtilEntry, wsParam])

  // ---- layout state ----

  const agentWidth = agentWidthStore.useWidth()
  const utilWidth = utilWidthStore.useWidth()
  const [agentResizing, setAgentResizing] = useState(false)
  const [utilResizing, setUtilResizing] = useState(false)

  // Defensive: agents/insertHotAgent/validSelectionFromTemplate/ArchivedAgent/
  // makeCollection are kept available for the future inline-create path.
  void agents
  void insertHotAgent
  void validSelectionFromTemplate
  void makeCollection
  void activeWorkspaceId
  type _Unused = ArchivedAgent

  return (
    <div className="flex flex-row h-full min-h-0 min-w-0">
      {sidebarOpen && (
        <div
          className="shrink-0 flex flex-col overflow-hidden text-[13px]"
          style={{
            width: agentWidth,
            borderRight: "1px solid var(--zenbu-panel-border)",
          }}
        >
          <AgentList
            agents={agents}
            views={sortedViews as View[]}
            activeViewId={activeViewId}
            currentWorkspaceId={workspaceIdParam || null}
            windowId={windowId}
            onSwitchTab={handleSwitchTab}
            onCloseTab={handleCloseTab}
            onCloseTabQuiet={handleCloseTabQuiet}
            onNewAgent={handleNewAgent}
            onOpenPlugins={handleOpenPlugins}
          />
        </div>
      )}
      {sidebarOpen && (
        <ResizeHandle
          onResizeChange={setAgentResizing}
          direction="right"
          store={agentWidthStore}
        />
      )}
      {agentResizing && <ResizeOverlay />}

      <div className="flex-1 min-w-0 min-h-0 relative">
        {sortedViews.length > 0 ? (
          <ActiveView
            views={sortedViews as View[]}
            activeViewId={activeViewId}
            registryMap={registryMap}
            wsPort={wsPort}
            wsToken={wsToken}
            windowId={windowId}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
            <button
              onClick={handleNewAgent}
              className="px-3 py-1.5 rounded bg-secondary hover:bg-accent text-secondary-foreground transition-colors cursor-pointer"
            >
              + New Chat
            </button>
          </div>
        )}
      </div>

      {utilPanelVisible && (
        <ResizeHandle
          onResizeChange={setUtilResizing}
          direction="left"
          store={utilWidthStore}
        />
      )}
      {utilResizing && <ResizeOverlay />}

      {utilPanelVisible && (
        <div
          className="shrink-0 flex flex-col overflow-hidden"
          style={{
            width: utilWidth,
            background: "var(--zenbu-panel)",
            borderLeft: "1px solid var(--zenbu-panel-border)",
            borderRight: "1px solid var(--zenbu-panel-border)",
          }}
        >
          <div className="flex-1 min-h-0 relative">
            <ViewCacheSlot
              cacheKey={`utility-sidebar:${windowId}:${selectedUtilEntry!.scope}`}
              src={utilPanelSrc}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
              }}
            />
          </div>
        </div>
      )}

      <UtilityRail
        entries={sidebarEntries}
        selected={utilSelected ?? ""}
        panelVisible={utilPanelVisible}
        onIconClick={onUtilIconClick}
      />
    </div>
  )
}

function UtilityRail({
  entries,
  selected,
  panelVisible,
  onIconClick,
}: {
  entries: RegistryEntry[]
  selected: string
  panelVisible: boolean
  onIconClick: (scope: string) => void
}) {
  const RAIL_WIDTH = 44
  return (
    <div
      className="shrink-0 flex flex-col items-center gap-1 py-2"
      style={{
        width: RAIL_WIDTH,
        background: "var(--zenbu-panel)",
        borderLeft: panelVisible ? "none" : "1px solid var(--zenbu-panel-border)",
      }}
    >
      {entries.length === 0 && (
        <div
          className="text-[10px] text-muted-foreground px-1 text-center mt-2"
          title="No sidebar views registered"
        >
          no views
        </div>
      )}
      {entries.map((e) => (
        <button
          key={e.scope}
          type="button"
          onClick={() => onIconClick(e.scope)}
          title={formatScope(e.scope)}
          className={`usb-icon relative inline-flex items-center justify-center rounded text-muted-foreground cursor-pointer ${
            e.scope === selected ? "is-active" : ""
          }`}
          style={{ width: 36, height: 36 }}
        >
          {e.icon ? (
            <span
              className="inline-flex items-center justify-center"
              dangerouslySetInnerHTML={{ __html: e.icon }}
            />
          ) : (
            <span
              className="inline-flex items-center justify-center rounded"
              style={{
                width: 18,
                height: 18,
                fontSize: 11,
                fontWeight: 600,
                background: "var(--zenbu-control-hover)",
              }}
            >
              {(e.scope[0] ?? "?").toUpperCase()}
            </span>
          )}
        </button>
      ))}
      <style>{`
        .usb-icon { transition: background-color 80ms ease; }
        .usb-icon:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
        .usb-icon.is-active { background: var(--accent); color: var(--accent-foreground); }
        .usb-icon svg { width: 20px; height: 20px; filter: grayscale(100%); opacity: 0.65; transition: opacity 80ms ease; }
        .usb-icon:hover svg { opacity: 0.85; }
        .usb-icon.is-active svg { opacity: 1; }
      `}</style>
    </div>
  )
}

function ResizeHandle({
  onResizeChange,
  direction,
  store,
}: {
  onResizeChange: (resizing: boolean) => void
  direction: "left" | "right"
  store: { get: () => number; set: (v: number) => void }
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = store.get()
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      onResizeChange(true)

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        store.set(direction === "right" ? startWidth + delta : startWidth - delta)
      }
      const onUp = () => {
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        onResizeChange(false)
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [onResizeChange, store, direction],
  )

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 4,
        cursor: "col-resize",
        flexShrink: 0,
        background: "transparent",
        marginLeft: -2,
        marginRight: -2,
        zIndex: 1,
      }}
    />
  )
}

function ResizeOverlay() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        cursor: "col-resize",
        background: "transparent",
      }}
    />
  )
}

function formatScope(scope: string): string {
  return scope
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function ConnectedApp({
  connection,
}: {
  connection: Extract<WsConnectionState, { status: "connected" }>
}) {
  return (
    <RpcProvider value={connection.rpc}>
      <EventsProvider value={connection.events}>
        <KyjuClientProvider value={connection.kyjuClient}>
          <KyjuProvider client={connection.kyjuClient} replica={connection.replica}>
            <WorkspaceContent />
          </KyjuProvider>
        </KyjuClientProvider>
      </EventsProvider>
    </RpcProvider>
  )
}

export function App() {
  const connection = useWsConnection()
  if (connection.status === "connecting") return <div className="h-full" />
  if (connection.status === "error") {
    return (
      <div className="flex h-full items-center justify-center text-red-500 text-xs">
        {connection.error}
      </div>
    )
  }
  return <ConnectedApp connection={connection} />
}
