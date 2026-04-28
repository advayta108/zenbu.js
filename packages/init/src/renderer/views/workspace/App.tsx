import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { nanoid } from "nanoid"
import { makeCollection } from "@zenbu/kyju/schema"
import { useDb } from "@/lib/kyju-react"
import { ViewProvider } from "@/lib/View"
import { useKyjuClient, useRpc } from "@/lib/providers"
import { View } from "@/lib/View"
import { AgentList } from "@/views/orchestrator/components/AgentList"
import { ActiveView } from "@/views/orchestrator/components/ActiveView"
import {
  insertHotAgent,
  validSelectionFromTemplate,
  makeAgentAppState,
  makeViewAppState,
  makeWorkspaceAppState,
  type ArchivedAgent,
} from "../../../../shared/agent-ops"
import type { SchemaRoot, View as ViewRow } from "../../../../shared/schema"
import { useShortcutHandler } from "../../lib/shortcut-handler"

type AgentItem = SchemaRoot["agents"][number]
type RegistryEntry = {
  scope: string
  url: string
  port: number
  icon?: string
  workspaceId?: string
  meta?: {
    kind?: string
    sidebar?: boolean
    bottomPanel?: boolean
    label?: string
  }
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

  const activeViewId = useDb(
    (root) => root.plugin.kernel.windowState[windowId]?.activeViewId ?? null,
  )

  // The agent sidebar / utility-sidebar selection are properties of the
  // workspace *shell* view (one row per (window, workspace)), not of the
  // active chat tab. The orchestrator title bar agrees on the same id
  // formula, so toggling there updates the same row this iframe reads.
  const shellViewId = workspaceIdParam
    ? `workspace:${windowId}:${workspaceIdParam}`
    : null
  const shellViewState = shellViewId ? viewState[shellViewId] : null
  const sidebarOpen = shellViewState?.sidebarOpen ?? true
  const utilSelected = shellViewState?.utilitySidebarSelected ?? null

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

  // Per-workspace bottom-panel state. Defaults are defensive — old DBs
  // whose `workspaceState` rows predate the migration may not carry the
  // new fields, so we never trust them to be present.
  const workspaceStateMap =
    useDb((root) => root.plugin.kernel.workspaceState) ?? {}
  const activeWsState = workspaceIdParam
    ? workspaceStateMap[workspaceIdParam]
    : null
  const bottomPanelOpen = activeWsState?.bottomPanelOpen ?? false
  const bottomPanelSelected = activeWsState?.bottomPanelSelected ?? null
  const bottomPanelHeight = activeWsState?.bottomPanelHeight ?? 260

  const bottomEntries = useMemo<RegistryEntry[]>(() => {
    const all = registry.filter((e) => e.meta?.bottomPanel === true)
    return all.filter(
      (e) => !e.workspaceId || e.workspaceId === workspaceIdParam,
    )
  }, [registry])
  const selectedBottomEntry = useMemo(
    () => bottomEntries.find((e) => e.scope === bottomPanelSelected),
    [bottomEntries, bottomPanelSelected],
  )

  // Update the workspace-shell view's state row. Used for sidebarOpen
  // and utilitySidebarSelected, which are properties of the shell, not
  // of the active chat tab.
  const updateShellViewState = useCallback(
    (updater: (cur: SchemaRoot["viewState"][string]) => SchemaRoot["viewState"][string]) => {
      if (!shellViewId) return
      const all = client.plugin.kernel.viewState.read() ?? {}
      const cur = all[shellViewId]
      if (!cur) return
      void client.plugin.kernel.viewState.set({
        ...all,
        [shellViewId]: updater(cur),
      })
    },
    [client, shellViewId],
  )

  const updateActiveWorkspaceState = useCallback(
    (
      updater: (
        cur: SchemaRoot["workspaceState"][string],
      ) => SchemaRoot["workspaceState"][string],
    ) => {
      if (!workspaceIdParam) return
      const all = client.plugin.kernel.workspaceState.read() ?? {}
      const cur = all[workspaceIdParam] ?? makeWorkspaceAppState(workspaceIdParam)
      void client.plugin.kernel.workspaceState.set({
        ...all,
        [workspaceIdParam]: updater(cur),
      })
    },
    [client],
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
          props: {},
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
          props: {},
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
            oldView?.scope === "chat" ? oldView.props.agentId : undefined
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
          newView?.scope === "chat" ? newView.props.agentId : undefined
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
      const agentId = view?.scope === "chat" ? view.props.agentId : undefined
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
      updateShellViewState((cur) => ({
        ...cur,
        utilitySidebarSelected: next,
      }))
    },
    [updateShellViewState, utilSelected],
  )

  // Track lastViewId on the workspace whenever the active view changes.
  // Used to restore the last-viewed view when the workspace becomes active
  // again on this (or any) window.
  useEffect(() => {
    if (!activeViewId || !workspaceIdParam) return
    const cur = client.plugin.kernel.workspaceState.read() ?? {}
    const existing = cur[workspaceIdParam]
    if (existing?.lastViewId === activeViewId) return
    const base =
      existing ?? makeWorkspaceAppState(workspaceIdParam)
    void client.plugin.kernel.workspaceState.set({
      ...cur,
      [workspaceIdParam]: { ...base, lastViewId: activeViewId },
    })
  }, [activeViewId, client])

  // ---- iframe srcs ----

  const utilPanelVisible = selectedUtilEntry != null
  const bottomPanelVisible = bottomPanelOpen && selectedBottomEntry != null

  // ---- layout state ----

  const agentWidth = agentWidthStore.useWidth()
  const utilWidth = utilWidthStore.useWidth()
  const [agentResizing, setAgentResizing] = useState(false)
  const [utilResizing, setUtilResizing] = useState(false)
  // Local in-flight height during a vertical drag. Committed to kyju on
  // mouseup so we don't write through the WS on every pixel of movement.
  const [bottomDragHeight, setBottomDragHeight] = useState<number | null>(null)
  const [bottomResizing, setBottomResizing] = useState(false)
  const effectiveBottomHeight = bottomDragHeight ?? bottomPanelHeight

  // ---- Cmd+J: toggle bottom panel for this window's active workspace.
  // Uses { always: true } and gates manually because the keystroke can
  // originate from any nested iframe (chat, plugin) and document-level
  // focus checks would miss those cases. We filter to the focused
  // window via ctx.windowId, and to the active workspace iframe via
  // windowState[windowId].activeWorkspaceId — otherwise hidden cached
  // workspace iframes for inactive workspaces would also flip.
  useShortcutHandler({
    id: "kernel.toggleBottomPanel",
    when: { always: true },
    handler: (ctx) => {
      if (ctx.windowId !== windowId) return
      if (!workspaceIdParam) return
      const ws = client.plugin.kernel.windowState.read()?.[windowId]
      if (ws?.activeWorkspaceId !== workspaceIdParam) return

      const all = client.plugin.kernel.workspaceState.read() ?? {}
      const cur =
        all[workspaceIdParam] ?? makeWorkspaceAppState(workspaceIdParam)
      const nextOpen = !(cur.bottomPanelOpen ?? false)
      let nextSelected = cur.bottomPanelSelected ?? null
      if (nextOpen && !nextSelected && bottomEntries.length > 0) {
        nextSelected = bottomEntries[0].scope
      }
      void client.plugin.kernel.workspaceState.set({
        ...all,
        [workspaceIdParam]: {
          ...cur,
          bottomPanelOpen: nextOpen,
          bottomPanelSelected: nextSelected,
        },
      })
    },
  })

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
            views={sortedViews as ViewRow[]}
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

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 relative">
          {sortedViews.length > 0 ? (
            <ActiveView
              views={sortedViews as ViewRow[]}
              activeViewId={activeViewId}
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
        {bottomPanelVisible && (
          <BottomPanelResizeHandle
            getStartHeight={() => effectiveBottomHeight}
            onPreview={setBottomDragHeight}
            onCommit={() => {
              if (bottomDragHeight != null) {
                const next = bottomDragHeight
                updateActiveWorkspaceState((cur) => ({
                  ...cur,
                  bottomPanelHeight: next,
                }))
                setBottomDragHeight(null)
              }
            }}
            onResizeChange={setBottomResizing}
          />
        )}
        {bottomResizing && <ResizeOverlay direction="row" />}
        {bottomPanelVisible && (
          <BottomPanel
            entries={bottomEntries}
            selectedScope={bottomPanelSelected}
            height={effectiveBottomHeight}
            windowId={windowId}
            onSelectScope={(scope) => {
              updateActiveWorkspaceState((cur) => ({
                ...cur,
                bottomPanelSelected: scope,
              }))
            }}
            onClose={() => {
              updateActiveWorkspaceState((cur) => ({
                ...cur,
                bottomPanelOpen: false,
              }))
            }}
          />
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
            <View
              id={`util:${windowId}:${selectedUtilEntry!.scope}`}
              scope={selectedUtilEntry!.scope}
              pinned
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

function ResizeOverlay({ direction = "col" }: { direction?: "col" | "row" }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        cursor: direction === "row" ? "row-resize" : "col-resize",
        background: "transparent",
      }}
    />
  )
}

function BottomPanelResizeHandle({
  getStartHeight,
  onPreview,
  onCommit,
  onResizeChange,
}: {
  getStartHeight: () => number
  onPreview: (next: number) => void
  onCommit: () => void
  onResizeChange: (resizing: boolean) => void
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startHeight = getStartHeight()
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
      onResizeChange(true)

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY
        // Drag up shrinks delta (negative) → bigger panel; clamp.
        const next = Math.max(120, Math.min(800, startHeight - delta))
        onPreview(next)
      }
      const onUp = () => {
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        onResizeChange(false)
        onCommit()
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [getStartHeight, onPreview, onCommit, onResizeChange],
  )

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        height: 4,
        cursor: "row-resize",
        flexShrink: 0,
        background: "transparent",
        marginTop: -2,
        marginBottom: -2,
        zIndex: 1,
      }}
    />
  )
}

function BottomPanel({
  entries,
  selectedScope,
  height,
  windowId,
  onSelectScope,
  onClose,
}: {
  entries: RegistryEntry[]
  selectedScope: string | null
  height: number
  windowId: string
  onSelectScope: (scope: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        height,
        background: "var(--zenbu-panel)",
        borderTop: "1px solid var(--zenbu-panel-border)",
      }}
    >
      <div
        className="shrink-0 flex items-center gap-1 px-2"
        style={{
          height: 28,
          borderBottom: "1px solid var(--zenbu-panel-border)",
          background: "var(--zenbu-panel)",
        }}
      >
        {entries.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1">
            no bottom-panel views
          </div>
        ) : (
          entries.map((e) => {
            const label = e.meta?.label ?? formatScope(e.scope)
            return (
              <button
                key={e.scope}
                type="button"
                onClick={() => onSelectScope(e.scope)}
                className={`bp-tab inline-flex items-center gap-1 px-2 h-[22px] rounded text-[11px] cursor-pointer ${
                  e.scope === selectedScope ? "is-active" : ""
                }`}
                title={label}
              >
                {e.icon && (
                  <span
                    className="inline-flex items-center justify-center"
                    dangerouslySetInnerHTML={{ __html: e.icon }}
                  />
                )}
                <span>{label}</span>
              </button>
            )
          })
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          title="Close (Cmd+J)"
          className="bp-close inline-flex items-center justify-center rounded cursor-pointer"
          style={{ width: 22, height: 22 }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {selectedScope && (
          <View
            id={`bottom-panel:${windowId}:${selectedScope}`}
            scope={selectedScope}
            pinned
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }}
          />
        )}
      </div>
      <style>{`
        .bp-tab { color: var(--muted-foreground); transition: background-color 80ms ease; }
        .bp-tab:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
        .bp-tab.is-active { background: var(--accent); color: var(--accent-foreground); }
        .bp-tab svg { width: 12px; height: 12px; opacity: 0.85; }
        .bp-close { color: var(--muted-foreground); transition: background-color 80ms ease; }
        .bp-close:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
      `}</style>
    </div>
  )
}

function formatScope(scope: string): string {
  return scope
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

export function App() {
  return (
    <ViewProvider fallback={<div className="h-full" />}>
      <WorkspaceContent />
    </ViewProvider>
  )
}
