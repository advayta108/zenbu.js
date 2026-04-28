import type {
  SchemaRoot,
  View,
  WindowAppState,
  ViewAppState,
  AgentAppState,
  WorkspaceAppState,
} from "./schema";

type Kernel = SchemaRoot;
export type HotAgent = Kernel["agents"][number];
export type ArchivedAgent = HotAgent & { archivedAt: number };

// ---------------------------------------------------------------------------
// State-record factory helpers.
//
// Invariant: kernel.<x>State[id].<idField> === id for every record. These
// factories are the single source of truth for that invariant - new call
// sites should use them rather than constructing records inline.
// ---------------------------------------------------------------------------

export function makeWindowAppState(
  windowId: string,
  overrides?: Partial<Omit<WindowAppState, "windowId">>,
): WindowAppState {
  return {
    windowId,
    activeViewId: null,
    activeWorkspaceId: null,
    ...overrides,
  };
}

export function makeViewAppState(
  viewId: string,
  overrides?: Partial<Omit<ViewAppState, "viewId">>,
): ViewAppState {
  return {
    viewId,
    draft: null,
    pendingCwd: null,
    order: 0,
    sidebarOpen: false,
    tabSidebarOpen: true,
    sidebarPanel: "overview",
    utilitySidebarSelected: null,
    cachedAt: null,
    ...overrides,
  };
}

export function makeAgentAppState(
  agentId: string,
  overrides?: Partial<Omit<AgentAppState, "agentId">>,
): AgentAppState {
  return {
    agentId,
    lastViewedAt: null,
    workspaceId: null,
    ...overrides,
  };
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
  };
}

// ---------------------------------------------------------------------------
// View / agent lookup helpers.
// ---------------------------------------------------------------------------

/**
 * Find an existing chat-view that already references this agent, so a caller
 * about to create a fresh window/view can focus the existing one instead of
 * duplicating the agent into a second tab. Returns the first match across
 * all windows.
 */
export function findExistingViewForAgent(
  views: readonly View[],
  agentId: string,
): { windowId: string; viewId: string } | null {
  for (const v of views) {
    if (v.scope === "chat" && v.props.agentId === agentId) {
      return { windowId: v.windowId, viewId: v.id };
    }
  }
  return null;
}

/**
 * Resolve the agentId a view points to, by reading its params. Returns null
 * for non-chat views or views with no agentId param.
 */
export function findAgentIdForView(
  views: readonly View[],
  viewId: string,
): string | null {
  const v = views.find((x) => x.id === viewId);
  return v?.props.agentId ?? null;
}

/**
 * "Live" check for InsertService: is this view the active view of the
 * focused window? Only then is it safe to dispatch a cross-window insert
 * event without racing local edits in another composer (no merge protocol).
 *
 * Everything else goes through the persisted-draft path on the view's state
 * record; the composer picks up the change on refocus.
 */
export function findLiveViewTab(
  kernel: Kernel,
  viewId: string,
): { windowId: string } | null {
  const focusedWindowId = kernel.focusedWindowId;
  if (!focusedWindowId) return null;
  const ws = kernel.windowState[focusedWindowId];
  if (!ws) return null;
  if (ws.activeViewId !== viewId) return null;
  // Confirm the entity exists; defensive against a torn-off view that's
  // still pointed-to by a stale activeViewId.
  if (!kernel.views.some((v) => v.id === viewId)) return null;
  return { windowId: focusedWindowId };
}

/**
 * Activate a view in its window. Sets `windowState[windowId].activeViewId`,
 * and updates the unread-badge state on `agentState`:
 *   - the now-active chat view's agent: lastViewedAt = null (currently viewing)
 *   - the previously-active chat view's agent: lastViewedAt = now (just left)
 *
 * Must be called inside a `client.update((root) => ...)` callback.
 */
export function activateView(
  kernel: Kernel,
  target: { windowId: string; viewId: string },
): void {
  const ws = kernel.windowState[target.windowId];
  if (!ws) return;
  const previousViewId = ws.activeViewId;
  ws.activeViewId = target.viewId;

  const now = Date.now();

  // Mark the previously-active chat view's agent as "departed" (unread state).
  if (previousViewId && previousViewId !== target.viewId) {
    const prevView = kernel.views.find((v) => v.id === previousViewId);
    const prevAgentId =
      prevView?.scope === "chat" ? prevView.props.agentId : undefined;
    if (prevAgentId) {
      const prev = kernel.agentState[prevAgentId];
      if (prev) {
        prev.lastViewedAt = now;
      } else {
        kernel.agentState[prevAgentId] = makeAgentAppState(prevAgentId, {
          lastViewedAt: now,
        });
      }
    }
  }

  // Clear unread on the now-active chat view's agent.
  const newView = kernel.views.find((v) => v.id === target.viewId);
  const newAgentId =
    newView?.scope === "chat" ? newView.props.agentId : undefined;
  if (newAgentId) {
    const cur = kernel.agentState[newAgentId];
    if (cur) {
      cur.lastViewedAt = null;
    } else {
      kernel.agentState[newAgentId] = makeAgentAppState(newAgentId, {
        lastViewedAt: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Hot-agent / archived-agent helpers (unchanged from prior implementation).
// ---------------------------------------------------------------------------

type AgentConfig = Kernel["agentConfigs"][number];

/**
 * Snap a saved selection back to the available list for this kind. Returns
 * only the fields whose saved value is currently valid; unset (or
 * out-of-range) fields are omitted so the caller's spread doesn't
 * resurrect stale values. Used to seed a fresh agent instance from the
 * template's `defaultConfiguration`.
 */
export function validSelectionFromTemplate(
  template: AgentConfig,
): { model?: string; thinkingLevel?: string; mode?: string } {
  const dflt = template.defaultConfiguration ?? {};
  const out: { model?: string; thinkingLevel?: string; mode?: string } = {};
  if (
    dflt.model &&
    (!template.availableModels?.length ||
      template.availableModels.some((m) => m.value === dflt.model))
  ) {
    out.model = dflt.model;
  }
  if (
    dflt.thinkingLevel &&
    (!template.availableThinkingLevels?.length ||
      template.availableThinkingLevels.some(
        (t) => t.value === dflt.thinkingLevel,
      ))
  ) {
    out.thinkingLevel = dflt.thinkingLevel;
  }
  if (
    dflt.mode &&
    (!template.availableModes?.length ||
      template.availableModes.some((m) => m.value === dflt.mode))
  ) {
    out.mode = dflt.mode;
  }
  return out;
}

/**
 * Insert a freshly-created agent into `kernel.agents`, enforcing the
 * `hotAgentsCap` limit. If the array is already at/above the cap, the
 * oldest-by-`createdAt` hot agents are removed from the array and returned
 * as archived records so the caller can push them into the `archivedAgents`
 * collection after the update resolves (collections aren't draft-mutable).
 *
 * Must be called inside a `client.update((root) => ...)` callback; mutates
 * the draft kernel in place.
 */
export function insertHotAgent(
  kernel: Kernel,
  agent: HotAgent,
): ArchivedAgent[] {
  const evicted: ArchivedAgent[] = [];
  while (kernel.agents.length >= kernel.hotAgentsCap) {
    let oldestIdx = 0;
    for (let i = 1; i < kernel.agents.length; i++) {
      if (kernel.agents[i].createdAt < kernel.agents[oldestIdx].createdAt) {
        oldestIdx = i;
      }
    }
    const e = kernel.agents[oldestIdx];
    evicted.push({ ...e, archivedAt: Date.now() });
    kernel.agents = [
      ...kernel.agents.slice(0, oldestIdx),
      ...kernel.agents.slice(oldestIdx + 1),
    ];
  }
  kernel.agents = [...kernel.agents, agent];
  return evicted;
}
