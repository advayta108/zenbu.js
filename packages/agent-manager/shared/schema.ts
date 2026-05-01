import zod from "zod"
import {
  createSchema,
  f,
  type InferSchema,
  type InferRoot,
} from "@zenbu/kyju/schema"

// ---------------------------------------------------------------------------
// Agent-manager schema section.
//
// Owns the workspace-shell UX state that used to live on `kernel`. Splits
// out:
//   - workspaceState        (per-workspace shell chrome: bottom panel, last view)
//   - agentState            (per-agent navigation state: lastViewedAt, workspace binding)
//   - workspaceShellState   (per shell-view-id: sidebar/util/panel selections)
//   - pool / poolSize       (warm-pool of pre-spawned agents for the new-agent picker)
//
// `kernel.viewState[id]` keeps generic per-view state (cachedAt, loadedAt,
// draft, order, ...). The four sidebar fields that used to live on every
// view's row are agent-manager-specific now: only the workspace shell
// view actually carries them, so they live keyed by `shellViewId` here.
// ---------------------------------------------------------------------------

const workspaceShellStateSchema = zod.object({
  shellViewId: zod.string(),
  sidebarOpen: zod.boolean().default(true),
  tabSidebarOpen: zod.boolean().default(true),
  sidebarPanel: zod.string().default("overview"),
  utilitySidebarSelected: zod.string().nullable().default(null),
})

const agentAppStateSchema = zod.object({
  agentId: zod.string(),
  lastViewedAt: zod.number().nullable().default(null),
  workspaceId: zod.string().nullable().default(null),
})

const workspaceAppStateSchema = zod.object({
  workspaceId: zod.string(),
  lastViewId: zod.string().nullable().default(null),
  bottomPanelOpen: zod.boolean().default(false),
  bottomPanelSelected: zod.string().nullable().default(null),
  bottomPanelHeight: zod.number().default(260),
})

export const agentManagerSchema = createSchema({
  workspaceState: f
    .record(zod.string(), workspaceAppStateSchema)
    .default({}),
  agentState: f.record(zod.string(), agentAppStateSchema).default({}),
  workspaceShellState: f
    .record(zod.string(), workspaceShellStateSchema)
    .default({}),
  pool: f
    .array(zod.object({ agentId: zod.string() }))
    .default([]),
  poolSize: f.number().default(1),
})

export const schema = agentManagerSchema

export type AgentManagerSchema = InferSchema<typeof agentManagerSchema>
export type SchemaRoot = InferRoot<AgentManagerSchema>

export type WorkspaceShellState = zod.infer<typeof workspaceShellStateSchema>
export type AgentAppState = zod.infer<typeof agentAppStateSchema>
export type WorkspaceAppState = zod.infer<typeof workspaceAppStateSchema>

// ---------------------------------------------------------------------------
// Factory helpers — single source of truth for `{ idField: id }` invariants.
// ---------------------------------------------------------------------------

export function makeAgentAppState(
  agentId: string,
  overrides?: Partial<Omit<AgentAppState, "agentId">>,
): AgentAppState {
  return {
    agentId,
    lastViewedAt: null,
    workspaceId: null,
    ...overrides,
  }
}

export function makeWorkspaceAppState(
  workspaceId: string,
  overrides?: Partial<Omit<WorkspaceAppState, "workspaceId">>,
): WorkspaceAppState {
  return {
    workspaceId,
    lastViewId: null,
    bottomPanelOpen: false,
    bottomPanelSelected: null,
    bottomPanelHeight: 260,
    ...overrides,
  }
}

export function makeWorkspaceShellState(
  shellViewId: string,
  overrides?: Partial<Omit<WorkspaceShellState, "shellViewId">>,
): WorkspaceShellState {
  return {
    shellViewId,
    sidebarOpen: true,
    tabSidebarOpen: true,
    sidebarPanel: "overview",
    utilitySidebarSelected: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// activateView — cross-section helper.
//
// Sets `windowState[windowId].activeViewId` on the kernel section, AND
// updates the unread-badge state on `agentState` in the agent-manager
// section:
//   - the now-active chat view's agent: lastViewedAt = null
//   - the previously-active chat view's agent: lastViewedAt = now
//
// Must be called inside a `client.update((root) => ...)` callback. Takes
// the merged draft root (typed loosely here so both init and agent-manager
// callers can use it without a circular type dep).
// ---------------------------------------------------------------------------

type AnyView = { id: string; scope: string; props: Record<string, string> }
type AnyKernel = {
  windowState: Record<
    string,
    { windowId: string; activeViewId: string | null; activeWorkspaceId: string | null }
  >
  views: AnyView[]
}
type AnyAgentManager = { agentState: Record<string, AgentAppState> }
type AnyRoot = {
  plugin: { kernel: AnyKernel; "agent-manager": AnyAgentManager }
}

export function activateView(
  root: AnyRoot,
  target: { windowId: string; viewId: string },
): void {
  const k = root.plugin.kernel
  const am = root.plugin["agent-manager"]
  const ws = k.windowState[target.windowId]
  if (!ws) return
  const previousViewId = ws.activeViewId
  ws.activeViewId = target.viewId

  const now = Date.now()

  if (previousViewId && previousViewId !== target.viewId) {
    const prevView = k.views.find((v) => v.id === previousViewId)
    const prevAgentId =
      prevView?.scope === "chat" ? prevView.props.agentId : undefined
    if (prevAgentId) {
      const prev = am.agentState[prevAgentId]
      if (prev) {
        prev.lastViewedAt = now
      } else {
        am.agentState[prevAgentId] = makeAgentAppState(prevAgentId, {
          lastViewedAt: now,
        })
      }
    }
  }

  const newView = k.views.find((v) => v.id === target.viewId)
  const newAgentId =
    newView?.scope === "chat" ? newView.props.agentId : undefined
  if (newAgentId) {
    const cur = am.agentState[newAgentId]
    if (cur) {
      cur.lastViewedAt = null
    } else {
      am.agentState[newAgentId] = makeAgentAppState(newAgentId, {
        lastViewedAt: null,
      })
    }
  }
}
