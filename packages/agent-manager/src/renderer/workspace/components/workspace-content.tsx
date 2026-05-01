import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { nanoid } from "nanoid"
import { useDb } from "#zenbu/init/src/renderer/lib/kyju-react"
import { useKyjuClient, useRpc } from "#zenbu/init/src/renderer/lib/providers"
import { View } from "#zenbu/init/src/renderer/lib/View"
import { AgentList } from "#zenbu/init/src/renderer/views/orchestrator/components/AgentList"
import { ActiveView } from "#zenbu/init/src/renderer/views/orchestrator/components/ActiveView"
import { useShortcutHandler } from "#zenbu/init/src/renderer/lib/shortcut-handler"
import { makeViewAppState } from "#zenbu/init/shared/agent-ops"
import type { View as ViewRow } from "#zenbu/init/shared/schema"
import {
  makeAgentAppState,
  makeWorkspaceAppState,
  makeWorkspaceShellState,
} from "../../../../shared/schema"
import {
  agentWidthStore,
  utilWidthStore,
} from "../lib/width-store"
import { windowId, workspaceIdParam, shellViewId } from "../lib/params"
import { UtilityRail, type RegistryEntry } from "./utility-rail"
import { ResizeHandle } from "./resize-handle"
import { ResizeOverlay } from "./resize-overlay"
import { BottomPanelResizeHandle } from "./bottom-panel-resize-handle"
import { BottomPanel } from "./bottom-panel"
import { SidebarToggle } from "./sidebar-toggle"
import { SidebarHeader } from "./sidebar-header"
import { AgentPicker } from "./agent-picker"

export function WorkspaceContent() {
  const client = useKyjuClient()
  const rpc = useRpc()

  const allViews = useDb((root) => root.plugin.kernel.views) ?? []
  const views = useMemo(
    () => allViews.filter((v) => v.windowId === windowId).map((v) => v),
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
  const agentStateMap =
    useDb((root) => root.plugin["agent-manager"].agentState) ?? {}

  // Scoped agent list for the workspace agent picker: bound to this
  // workspace, OR unbound (legacy / pre-promote pool). Mirrors the
  // sidebar's filter so the picker doesn't surface tabs from another
  // workspace.
  const workspaceAgents = useMemo(() => {
    if (!workspaceIdParam) return agents
    return agents.filter((a) => {
      const bound = agentStateMap[a.id]?.workspaceId ?? null
      return bound === null || bound === workspaceIdParam
    })
  }, [agents, agentStateMap])

  // Agents whose chat view is already open in this window — the picker
  // hides these so it only offers "load an existing one" choices.
  const openAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const v of allViews) {
      if (v.windowId !== windowId) continue
      if (v.scope !== "chat") continue
      const id = v.props.agentId
      if (id) ids.add(id)
    }
    return ids
  }, [allViews])

  const registry = useDb((root) => root.plugin.kernel.viewRegistry) ?? []

  const activeViewId = useDb(
    (root) => root.plugin.kernel.windowState[windowId]?.activeViewId ?? null,
  )
  const activeViewScope = useMemo(
    () => sortedViews.find((v) => v.id === activeViewId)?.scope ?? null,
    [sortedViews, activeViewId],
  )

  // Workspace-shell UX state lives in agent-manager.workspaceShellState now,
  // keyed by `workspace:${windowId}:${workspaceId}`. The orchestrator does
  // not write this field anymore — the toggle below is the only writer.
  const shellState = useDb((root) =>
    shellViewId
      ? root.plugin["agent-manager"].workspaceShellState[shellViewId]
      : undefined,
  )
  const sidebarOpen = shellState?.sidebarOpen ?? true
  const utilSelected = shellState?.utilitySidebarSelected ?? null

  const sidebarEntries = useMemo<RegistryEntry[]>(
    () =>
      registry
        .filter((e) => e.meta?.sidebar === true)
        .filter((e) => !e.workspaceId || e.workspaceId === workspaceIdParam),
    [registry],
  )
  const selectedUtilEntry = useMemo(
    () => sidebarEntries.find((e) => e.scope === utilSelected),
    [sidebarEntries, utilSelected],
  )

  // Per-workspace bottom-panel state. Lives on agent-manager.workspaceState.
  const workspaceStateMap =
    useDb((root) => root.plugin["agent-manager"].workspaceState) ?? {}
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

  // Mutate the workspace-shell record in agent-manager. Used by the sidebar
  // toggle and utility-rail icon clicks. Always seeds a row if absent so the
  // first toggle/click after boot lands somewhere instead of no-op'ing.
  const updateShellState = useCallback(
    (
      updater: (
        cur: ReturnType<typeof makeWorkspaceShellState>,
      ) => ReturnType<typeof makeWorkspaceShellState>,
    ) => {
      if (!shellViewId) return
      const all =
        client.plugin["agent-manager"].workspaceShellState.read() ?? {}
      const cur = all[shellViewId] ?? makeWorkspaceShellState(shellViewId)
      void client.plugin["agent-manager"].workspaceShellState.set({
        ...all,
        [shellViewId]: updater(cur),
      })
    },
    [client],
  )

  const updateActiveWorkspaceState = useCallback(
    (
      updater: (
        cur: ReturnType<typeof makeWorkspaceAppState>,
      ) => ReturnType<typeof makeWorkspaceAppState>,
    ) => {
      if (!workspaceIdParam) return
      const all = client.plugin["agent-manager"].workspaceState.read() ?? {}
      const cur =
        all[workspaceIdParam] ?? makeWorkspaceAppState(workspaceIdParam)
      void client.plugin["agent-manager"].workspaceState.set({
        ...all,
        [workspaceIdParam]: updater(cur),
      })
    },
    [client],
  )

  const onToggleSidebar = useCallback(() => {
    updateShellState((cur) => ({ ...cur, sidebarOpen: !cur.sidebarOpen }))
  }, [updateShellState])

  // ---- handlers ----

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

  const handleNewAgent = useCallback(async () => {
    const newViewId = nanoid()
    const order = nextOrder()
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
        [newViewId]: makeViewAppState(newViewId, { order }),
      }
      const ws = k.windowState[windowId]
      if (ws) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: newViewId },
        }
      }
    })
  }, [client, nextOrder, activeViewId])

  const handleOpenPlugins = useCallback(async () => {
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
        [newViewId]: makeViewAppState(newViewId, { order }),
      }
      const ws = k.windowState[windowId]
      if (ws) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: newViewId },
        }
      }
    })
  }, [client, sortedViews, nextOrder, activeViewId])

  // Load an existing agent into a new chat view in this window, then
  // make it active. Mirrors what the orchestrator's title-bar picker
  // used to do, except now it lives inside the workspace shell so the
  // search is naturally workspace-scoped.
  const handleLoadAgent = useCallback(
    async (agentId: string) => {
      const newViewId = nanoid()
      const order = nextOrder()
      await client.update((root) => {
        const k = root.plugin.kernel
        k.views = [
          ...k.views,
          {
            id: newViewId,
            windowId,
            parentId: null,
            scope: "chat",
            props: { agentId },
            createdAt: Date.now(),
          },
        ]
        k.viewState = {
          ...k.viewState,
          [newViewId]: makeViewAppState(newViewId, { order }),
        }
        const ws = k.windowState[windowId]
        if (ws) {
          k.windowState = {
            ...k.windowState,
            [windowId]: { ...ws, activeViewId: newViewId },
          }
        }
      })
    },
    [client, nextOrder],
  )

  const handleSwitchTab = useCallback(
    async (viewId: string) => {
      await client.update((root) => {
        const k = root.plugin.kernel
        const ws = k.windowState[windowId]
        if (!ws) return
        if (ws.activeViewId === viewId) return
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
      updateShellState((cur) => ({ ...cur, utilitySidebarSelected: next }))
    },
    [updateShellState, utilSelected],
  )

  // Workspace view is the single writer for agent-manager state tied to
  // "tab actually became active in this window". The orchestrator's
  // title-bar agent picker only sets windowState.activeViewId; this effect
  // fans out the consequences (lastViewedAt clear/set, lastViewId).
  const prevActiveViewIdRef = useRef<string | null>(activeViewId)
  useEffect(() => {
    if (!workspaceIdParam) return
    const prev = prevActiveViewIdRef.current
    prevActiveViewIdRef.current = activeViewId

    void client.update((root) => {
      const k = root.plugin.kernel
      const am = root.plugin["agent-manager"]
      const now = Date.now()

      // Mark previously-active chat agent as departed (unread state on).
      if (prev && prev !== activeViewId) {
        const prevView = k.views.find((v) => v.id === prev)
        const prevAgentId =
          prevView?.scope === "chat" ? prevView.props.agentId : undefined
        if (prevAgentId) {
          const cur = am.agentState[prevAgentId]
          am.agentState = {
            ...am.agentState,
            [prevAgentId]: cur
              ? { ...cur, lastViewedAt: now }
              : makeAgentAppState(prevAgentId, { lastViewedAt: now }),
          }
        }
      }

      // Clear unread on the now-active chat agent.
      if (activeViewId) {
        const newView = k.views.find((v) => v.id === activeViewId)
        const newAgentId =
          newView?.scope === "chat" ? newView.props.agentId : undefined
        if (newAgentId) {
          const cur = am.agentState[newAgentId]
          am.agentState = {
            ...am.agentState,
            [newAgentId]: cur
              ? { ...cur, lastViewedAt: null }
              : makeAgentAppState(newAgentId, { lastViewedAt: null }),
          }
        }
      }

      // Track lastViewId on the workspace so re-entry restores it.
      if (activeViewId) {
        const cur = am.workspaceState[workspaceIdParam]
        if (!cur || cur.lastViewId !== activeViewId) {
          const base = cur ?? makeWorkspaceAppState(workspaceIdParam)
          am.workspaceState = {
            ...am.workspaceState,
            [workspaceIdParam]: { ...base, lastViewId: activeViewId },
          }
        }
      }
    })
  }, [activeViewId, client])

  const utilPanelVisible = selectedUtilEntry != null
  const bottomPanelVisible = bottomPanelOpen && selectedBottomEntry != null

  const agentWidth = agentWidthStore.useWidth()
  const utilWidth = utilWidthStore.useWidth()
  const [agentResizing, setAgentResizing] = useState(false)
  const [utilResizing, setUtilResizing] = useState(false)
  const [bottomDragHeight, setBottomDragHeight] = useState<number | null>(null)
  const [bottomResizing, setBottomResizing] = useState(false)
  const effectiveBottomHeight = bottomDragHeight ?? bottomPanelHeight

  // Cmd+J — toggle bottom panel for this window's active workspace.
  useShortcutHandler({
    id: "kernel.toggleBottomPanel",
    when: { always: true },
    handler: (ctx) => {
      if (ctx.windowId !== windowId) return
      if (!workspaceIdParam) return
      const ws = client.plugin.kernel.windowState.read()?.[windowId]
      if (ws?.activeWorkspaceId !== workspaceIdParam) return

      const all = client.plugin["agent-manager"].workspaceState.read() ?? {}
      const cur =
        all[workspaceIdParam] ?? makeWorkspaceAppState(workspaceIdParam)
      const nextOpen = !(cur.bottomPanelOpen ?? false)
      let nextSelected = cur.bottomPanelSelected ?? null
      if (nextOpen && !nextSelected && bottomEntries.length > 0) {
        nextSelected = bottomEntries[0].scope
      }
      void client.plugin["agent-manager"].workspaceState.set({
        ...all,
        [workspaceIdParam]: {
          ...cur,
          bottomPanelOpen: nextOpen,
          bottomPanelSelected: nextSelected,
        },
      })
    },
  })

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
            headerExtras={
              <SidebarHeader
                onToggleSidebar={onToggleSidebar}
                right={
                  <AgentPicker
                    agents={workspaceAgents}
                    openAgentIds={openAgentIds}
                    onSelect={handleLoadAgent}
                  />
                }
              />
            }
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
        {!sidebarOpen && activeViewScope !== "chat" && (
          <div
            className="shrink-0 flex items-center px-1 py-1"
            style={{ height: 30 }}
          >
            <SidebarToggle open={false} onToggle={onToggleSidebar} />
          </div>
        )}
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
