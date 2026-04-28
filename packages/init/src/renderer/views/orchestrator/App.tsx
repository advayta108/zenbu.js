import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  SearchIcon,
  RotateCwIcon,
  DownloadIcon,
  GitMergeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { makeCollection } from "@zenbu/kyju/schema";
import {
  useWsConnection,
  RpcProvider,
  EventsProvider,
  KyjuClientProvider,
} from "../../lib/ws-connection";
import type { WsConnectionState } from "../../lib/ws-connection";
import { KyjuProvider, useDb, useCollection } from "../../lib/kyju-react";
import { useKyjuClient, useRpc } from "../../lib/providers";
import { DragRegionOverlay } from "../../lib/drag-region";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  PluginUpdateModal,
  type PendingUpdate,
} from "./components/PluginUpdateModal";
import { CliRelaunchModal } from "./components/CliRelaunchModal";
import { KernelBinaryUpdateBanner } from "./components/KernelBinaryUpdateBanner";
import { ShortcutForwarderProvider } from "./providers/shortcut-forwarder";
import { useFocusOnRequest } from "../../lib/focus-request";
import {
  insertHotAgent,
  validSelectionFromTemplate,
  makeAgentAppState,
  makeViewAppState,
  type ArchivedAgent,
} from "../../../../shared/agent-ops";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { ViewCacheSlot } from "../../lib/view-cache";

const params = new URLSearchParams(window.location.search);
const wsPort = Number(params.get("wsPort"));
const wsToken = params.get("wsToken") ?? "";
const windowId = params.get("windowId");
const defaultCwd = params.get("defaultCwd") ?? "";
if (!windowId) throw new Error("Missing ?windowId= in orchestrator URL");
if (!wsToken) throw new Error("Missing ?wsToken= in orchestrator URL");

import type { SchemaRoot } from "../../../../shared/schema";

type AgentItem = SchemaRoot["agents"][number];
type RegistryEntry = { scope: string; url: string; port: number };

type ErrorFallbackRender = (args: {
  error: Error;
  reset: () => void;
}) => ReactNode;

const ORCHESTRATOR_WORKSPACE_THEME_LINK_ID =
  "zenbu-orchestrator-workspace-theme";

function useWorkspaceThemeLink(workspaceId: string | null | undefined) {
  useEffect(() => {
    const existing = document.getElementById(
      ORCHESTRATOR_WORKSPACE_THEME_LINK_ID,
    );

    if (!workspaceId) {
      existing?.remove();
      return;
    }

    const link =
      existing instanceof HTMLLinkElement
        ? existing
        : document.createElement("link");
    link.id = ORCHESTRATOR_WORKSPACE_THEME_LINK_ID;
    link.rel = "stylesheet";
    link.href = `/@zenbu-theme/workspace.css?workspaceId=${encodeURIComponent(
      workspaceId,
    )}`;

    if (!link.isConnected) {
      document.body.appendChild(link);
    }
  }, [workspaceId]);
}

class ErrorBoundary extends Component<
  { children: ReactNode; scope: string; fallback: ErrorFallbackRender },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[orchestrator:${this.props.scope}] Uncaught error:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return this.props.fallback({
        error: this.state.error,
        reset: () => this.setState({ error: null }),
      });
    }
    return this.props.children;
  }
}

function FullErrorFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  const [showStack, setShowStack] = useState(false);

  return (
    <div className="flex h-full items-center justify-center bg-(--zenbu-panel) p-8">
      <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-red-200 bg-white p-6 shadow-sm">
        <div className="text-sm font-medium text-red-600">
          Something went wrong
        </div>
        <div className="text-xs text-neutral-600 font-mono break-all">
          {error.message}
        </div>
        {error.stack && (
          <button
            onClick={() => setShowStack((s) => !s)}
            className="text-xs text-neutral-400 hover:text-neutral-600 text-left cursor-pointer"
          >
            {showStack ? "Hide" : "Show"} stack trace
          </button>
        )}
        {showStack && error.stack && (
          <pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-3 text-[10px] text-neutral-500 leading-relaxed">
            {error.stack}
          </pre>
        )}
        <button
          onClick={onReset}
          className="mt-1 self-start rounded bg-neutral-800 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 cursor-pointer"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function TitleBarErrorFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 px-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className="flex flex-1 items-center gap-2 pl-[74px] min-w-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <span className="text-xs text-red-600 shrink-0">Title bar error</span>
        <span
          className="text-xs text-neutral-500 font-mono truncate"
          title={error.message}
        >
          {error.message}
        </span>
        <button
          onClick={onReset}
          className="ml-auto shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-xs text-white hover:bg-neutral-700 cursor-pointer"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function AgentLabel({ agent }: { agent: AgentItem }) {
  const { items: events } = useCollection(agent.eventLog);
  const label = useMemo(() => {
    if (agent.title?.kind === "set") return agent.title.value;
    let last: string | undefined;
    for (const event of events) {
      if (event.data.kind === "user_prompt") last = event.data.text;
    }
    return last?.replace(/\s+/g, " ").trim() || "New Chat";
  }, [agent.title, events]);
  return <>{label}</>;
}

function timeAgo(ts: number | undefined): string {
  if (!ts) return "";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function AgentPickerCombobox({
  agents,
  openAgentIds,
  onSelect,
}: {
  agents: AgentItem[];
  openAgentIds: Set<string>;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sortedAgents = useMemo(
    () =>
      [...agents]
        .filter((a) => !openAgentIds.has(a.id))
        .sort(
          (a, b) => (b.lastUserMessageAt ?? 0) - (a.lastUserMessageAt ?? 0),
        ),
    [agents, openAgentIds],
  );

  useEffect(() => {
    if (!open) return;

    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (triggerRef.current?.contains(target) ||
          contentRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };

    const closeOnWindowBlur = () => setOpen(false);

    document.addEventListener("pointerdown", closeIfOutside, true);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-neutral-500 transition-colors hover:bg-black/10 hover:text-neutral-700 text-xs"
          title="Load agent"
        >
          <SearchIcon size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        className="w-[280px] p-0 ml-2"
        align="start"
        onInteractOutside={() => setOpen(false)}
      >
        <Command>
          <CommandInput placeholder="Search agents..." />
          <CommandList>
            <CommandEmpty>No agents found.</CommandEmpty>
            <CommandGroup>
              {sortedAgents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.id}
                  onSelect={() => {
                    onSelect(agent.id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="truncate flex-1">
                    <AgentLabel agent={agent} />
                  </span>
                  {agent.lastUserMessageAt && (
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {timeAgo(agent.lastUserMessageAt)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type UpdateStatus =
  | { kind: "not-a-repo" }
  | { kind: "no-remote" }
  | { kind: "detached-head" }
  | { kind: "git-missing" }
  | { kind: "fetch-error"; message: string }
  | {
      kind: "ok";
      branch: string;
      ahead: number;
      behind: number;
      dirty: boolean;
      mergeable: boolean | null;
      conflictingFiles: string[];
      checkedAt: number;
    };

function ReloadMenu() {
  const rpc = useRpc();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pullPending, setPullPending] = useState<"check" | "pull" | null>(null);
  const [reloadPending, setReloadPending] = useState(false);
  const [transient, setTransient] = useState<"updated" | "up-to-date" | null>(
    null,
  );
  // When set, the shared `PluginUpdateModal` opens with this update — same
  // dialog the Settings → Updates / Plugins tabs use, so kernel and
  // per-plugin pulls share the install/cancel/progress UX exactly.
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(
    null,
  );

  const handleFullReload = async () => {
    if (reloadPending) return;
    setReloadPending(true);
    try {
      await rpc.runtime.reload();
    } catch (e) {
      console.error("[orchestrator] full reload failed:", e);
    } finally {
      setReloadPending(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const cached: UpdateStatus | null =
          await rpc.gitUpdates.getCachedStatus();
        if (cached) setStatus(cached);
      } catch {}
    })();
  }, [rpc]);

  useEffect(() => {
    if (!open) return;
    const closeOnWindowBlur = () => setOpen(false);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => window.removeEventListener("blur", closeOnWindowBlur);
  }, [open]);

  const hasConflicts = status?.kind === "ok" && status.mergeable === false;
  const hasUpdates =
    status?.kind === "ok" && status.behind > 0 && status.mergeable !== false;

  const flashTransient = (kind: "updated" | "up-to-date") => {
    setTransient(kind);
    setTimeout(() => {
      setTransient((cur) => (cur === kind ? null : cur));
    }, 2000);
  };

  const handlePullItem = async () => {
    if (hasConflicts || pullPending) return;
    setTransient(null);
    setPullPending(hasUpdates ? "pull" : "check");
    try {
      const result = await rpc.gitUpdates.pullAndInstall({ plugin: "kernel" });
      const next: UpdateStatus = await rpc.gitUpdates.checkUpdates(true);
      setStatus(next);
      if (result?.ok) {
        if (result.pending && result.version != null) {
          setPendingUpdate({ plugin: result.plugin, version: result.version });
        } else {
          flashTransient(result.updated ? "updated" : "up-to-date");
        }
      } else if (result?.error) {
        console.error("[orchestrator] pullAndInstall failed:", result.error);
      }
    } finally {
      setPullPending(null);
    }
  };

  const pullLabel =
    pullPending === "pull"
      ? "Pulling & installing…"
      : pullPending === "check"
        ? "Checking…"
        : hasConflicts
          ? "Conflicts — resolve in Settings"
          : transient === "updated"
            ? "Updated!"
            : transient === "up-to-date"
              ? "Up to date"
              : "Pull updates";

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={true}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 w-7 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-black/10 hover:text-neutral-700"
            title="Reload"
          >
            <RotateCwIcon size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[200px] text-xs"
        >
          <DropdownMenuItem
            className="text-xs"
            onClick={() => window.location.reload()}
          >
            <RotateCwIcon className="size-3" />
            Reload window
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs"
            disabled={reloadPending}
            onSelect={(e) => {
              e.preventDefault();
              handleFullReload();
            }}
          >
            <RefreshCwIcon className="size-3" />
            {reloadPending ? "Reloading…" : "Full reload"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs"
            disabled={hasConflicts || pullPending !== null}
            onSelect={(e) => {
              e.preventDefault();
              handlePullItem();
            }}
          >
            {hasConflicts ? (
              <GitMergeIcon className="size-3 text-red-500" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
            <span className="flex-1">{pullLabel}</span>
            {hasUpdates && pullPending === null && transient === null && (
              <span className="size-1.5 rounded-full bg-blue-500" />
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/*
      The update modal is rendered as a SIBLING of `<DropdownMenu>`, not a
      child. Radix's `DropdownMenu` manages its own portal + focus trap;
      nesting a `Dialog` (which has its own portal + focus trap) inside
      causes z-index stacking and focus-management fights when the menu
      tries to close while the dialog is open.
    */}
      <PluginUpdateModal
        pending={pendingUpdate}
        onResolved={() => setPendingUpdate(null)}
        descriptionPending="A new version of Zenbu is ready. This will install the update and restart the app."
      />
      <CliRelaunchModal />
    </>
  );
}

function TitleBar({
  agents,
  sidebarOpen,
  onToggleSidebar,
  openAgentIds,
  onLoadAgent,
  workspaceLabel,
}: {
  agents: AgentItem[];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  openAgentIds: Set<string>;
  onLoadAgent: (agentId: string) => void;
  workspaceLabel: string;
}) {
  return (
    <div
      className="shrink-0 relative flex items-center text-[13px]"
      style={
        {
          height: 36,
          background: "var(--zenbu-chrome)",
          paddingLeft: 78,
          paddingRight: 8,
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
    >
      <div
        className="flex items-center gap-0.5 relative"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <UtilityIconButton
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          onClick={onToggleSidebar}
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </UtilityIconButton>
        <ReloadMenu />
        <AgentPickerCombobox
          agents={agents}
          openAgentIds={openAgentIds}
          onSelect={onLoadAgent}
        />
      </div>
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        title={workspaceLabel}
      >
        <span className="truncate max-w-[60%] text-[12px] text-neutral-600 font-medium px-2">
          {workspaceLabel}
        </span>
      </div>
    </div>
  );
}

function UtilityIconButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center justify-center rounded text-neutral-500 cursor-pointer hover:bg-black/10 hover:text-neutral-700 transition-colors"
      style={{ width: 22, height: 22 }}
    >
      {children}
    </button>
  );
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      {open && (
        <rect
          x="3"
          y="3"
          width="6"
          height="18"
          fill="currentColor"
          fillOpacity="0.15"
          stroke="none"
        />
      )}
    </svg>
  );
}

function OrchestratorContent() {
  const agents = useDb((root) => root.plugin.kernel.agents);
  const allViews = useDb((root) => root.plugin.kernel.views) ?? [];
  // Open agents = agents that already have a chat view somewhere.
  const openAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const v of allViews) {
      if (v.scope === "chat" && v.params.agentId) ids.add(v.params.agentId);
    }
    return ids;
  }, [allViews]);
  const registry = useDb((root) => root.plugin.kernel.viewRegistry);
  const client = useKyjuClient();
  const rpc = useRpc();

  const ensuredRef = useRef(false);

  const activeWorkspaceId = useDb(
    (root) => root.plugin.kernel.windowState[windowId!]?.activeWorkspaceId ?? null,
  );
  useWorkspaceThemeLink(activeWorkspaceId);

  const workspaces = useDb((root) => root.plugin.kernel.workspaces);
  const activeWorkspace = useMemo(
    () => (workspaces ?? []).find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const workspaceCwds = activeWorkspace?.cwds ?? [];

  // Per-view sidebar state. Read from the active view's state record;
  // falls back to defaults if no active view.
  const activeViewId = useDb(
    (root) => root.plugin.kernel.windowState[windowId!]?.activeViewId ?? null,
  );
  const sidebarOpen = useDb((root) => {
    if (!activeViewId) return true;
    const vs = root.plugin.kernel.viewState[activeViewId];
    return vs?.sidebarOpen ?? false;
  });

  // Ensure the windows + windowState entries exist for our windowId. Most
  // windows are created by the main process; this is a defensive fill-in
  // for cold-start edge cases.
  useEffect(() => {
    if (ensuredRef.current || !windowId) return;
    const k = client.readRoot().plugin.kernel;
    if (k.windows.some((w) => w.id === windowId)) return;
    ensuredRef.current = true;
    void client.update((root) => {
      const kk = root.plugin.kernel;
      kk.windows = [...kk.windows, { id: windowId, persisted: false }];
      kk.windowState = {
        ...kk.windowState,
        [windowId]: kk.windowState[windowId] ?? {
          windowId,
          activeViewId: null,
          activeWorkspaceId: null,
        },
      };
    });
  }, [client]);

  const registryMap = useMemo(() => {
    const map = new Map<string, RegistryEntry>();
    for (const entry of registry) map.set(entry.scope, entry);
    return map;
  }, [registry]);

  // Load an existing agent into a new chat view in this window. Used by
  // the title-bar agent picker.
  const handleLoadAgent = useCallback(
    async (agentId: string) => {
      const newViewId = nanoid();
      const now = Date.now();
      await client.update((root) => {
        const k = root.plugin.kernel;
        // Determine sibling order: append after the highest existing order
        // among views in this window.
        let maxOrder = -1;
        for (const v of k.views) {
          if (v.windowId !== windowId) continue;
          const o = k.viewState[v.id]?.order ?? 0;
          if (o > maxOrder) maxOrder = o;
        }
        k.views = [
          ...k.views,
          {
            id: newViewId,
            windowId: windowId!,
            parentId: null,
            scope: "chat",
            params: { agentId },
            createdAt: now,
          },
        ];
        // Inherit sidebar state from the previously-active view for UX
        // continuity (otherwise sidebars reset on every new tab).
        const ws = k.windowState[windowId!];
        const prevViewId = ws?.activeViewId ?? null;
        const prev = prevViewId ? k.viewState[prevViewId] : null;
        k.viewState = {
          ...k.viewState,
          [newViewId]: makeViewAppState(newViewId, {
            order: maxOrder + 1,
            sidebarOpen: prev?.sidebarOpen ?? false,
            tabSidebarOpen: prev?.tabSidebarOpen ?? true,
            sidebarPanel: prev?.sidebarPanel ?? "overview",
            utilitySidebarSelected: prev?.utilitySidebarSelected ?? null,
          }),
        };
        // Mark the previously-active view's agent as departed (for the
        // unread-badge state machine on agentState).
        if (prevViewId) {
          const prevView = k.views.find((v) => v.id === prevViewId);
          const prevAgentId =
            prevView?.scope === "chat" ? prevView.params.agentId : undefined;
          if (prevAgentId) {
            const prevAS = k.agentState[prevAgentId];
            k.agentState = {
              ...k.agentState,
              [prevAgentId]: prevAS
                ? { ...prevAS, lastViewedAt: now }
                : makeAgentAppState(prevAgentId, { lastViewedAt: now }),
            };
          }
        }
        // Activate the new view.
        if (ws) {
          k.windowState = {
            ...k.windowState,
            [windowId!]: { ...ws, activeViewId: newViewId },
          };
        }
        // Clear unread on the loaded agent.
        const cur = k.agentState[agentId];
        k.agentState = {
          ...k.agentState,
          [agentId]: cur
            ? { ...cur, lastViewedAt: null }
            : makeAgentAppState(agentId, { lastViewedAt: null }),
        };
      });
    },
    [client],
  );

  const handleSelectWorkspace = useCallback(
    async (workspaceId: string) => {
      try {
        await rpc.workspace.activateWorkspace(windowId!, workspaceId);
      } catch (e) {
        console.error("[orchestrator] activateWorkspace failed:", e);
      }
    },
    [rpc],
  );

  // Per-view sidebar toggle: writes to viewState[activeViewId].sidebarOpen.
  // Falls back to a no-op if there's no active view (nothing to toggle on).
  const toggleSidebar = useCallback(() => {
    if (!activeViewId) return;
    const cur = client.plugin.kernel.viewState.read()?.[activeViewId];
    if (!cur) return;
    const next = { ...cur, sidebarOpen: !cur.sidebarOpen };
    const all = client.plugin.kernel.viewState.read() ?? {};
    client.plugin.kernel.viewState.set({ ...all, [activeViewId]: next });
  }, [client, activeViewId]);

  const rootFocusRef = useRef<HTMLDivElement>(null);
  useFocusOnRequest("orchestrator", () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    rootFocusRef.current?.focus();
  });

  // Keep references to fields that exist for the lint pass; the orchestrator
  // itself doesn't render the tab UI (workspace iframe does).
  void workspaceCwds;
  void defaultCwd;
  void useCollection;
  void agents;

  return (
    <div
      ref={rootFocusRef}
      tabIndex={-1}
      className="flex h-full flex-col bg-(--zenbu-panel) outline-none"
    >
      <ErrorBoundary
        scope="title-bar"
        fallback={({ error, reset }) => (
          <TitleBarErrorFallback error={error} onReset={reset} />
        )}
      >
        <TitleBar
          agents={agents}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          openAgentIds={openAgentIds}
          onLoadAgent={handleLoadAgent}
          workspaceLabel={activeWorkspace?.name ?? ""}
        />
      </ErrorBoundary>
      <KernelBinaryUpdateBanner />
      <div className="flex flex-row flex-1 min-h-0">
        <WorkspaceSidebar
          windowId={windowId!}
          activeWorkspaceId={activeWorkspaceId ?? null}
          onSelectWorkspace={handleSelectWorkspace}
        />
        <ErrorBoundary
          scope="workspace-view"
          fallback={({ error, reset }) => (
            <FullErrorFallback error={error} onReset={reset} />
          )}
        >
          <WorkspaceFrame
            workspaceId={activeWorkspaceId ?? null}
            registryMap={registryMap}
            wsPort={wsPort}
            wsToken={wsToken}
            windowId={windowId!}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function WorkspaceFrame({
  workspaceId,
  registryMap,
  wsPort,
  wsToken,
  windowId,
}: {
  workspaceId: string | null;
  registryMap: Map<string, RegistryEntry>;
  wsPort: number;
  wsToken: string;
  windowId: string;
}) {
  const entry = registryMap.get("workspace");
  if (!entry) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center text-neutral-400 text-xs">
        Workspace view not registered
      </div>
    );
  }
  if (!workspaceId) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center text-neutral-400 text-xs">
        {/* Pick or create a workspace */}
      </div>
    );
  }
  let entryPath = new URL(entry.url).pathname;
  const ownsServer = entryPath === "/" || entryPath === "";
  if (ownsServer) entryPath = "";
  else if (entryPath.endsWith("/")) entryPath = entryPath.slice(0, -1);
  const targetPort = ownsServer ? entry.port : wsPort;
  const cacheKey = `workspace:${windowId}:${workspaceId}`;
  // Unique subdomain per (window, workspace) so each workspace gets its
  // own iframe Origin for cookies / localStorage / etc.
  const raw = `ws-${windowId}-${workspaceId}`;
  const hostname = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const src = `http://${hostname}.localhost:${targetPort}${entryPath}/index.html?wsPort=${wsPort}&wsToken=${encodeURIComponent(
    wsToken,
  )}&windowId=${encodeURIComponent(
    windowId,
  )}&workspaceId=${encodeURIComponent(workspaceId)}`;
  return (
    <div
      className="flex-1 min-w-0 min-h-0 relative"
      // Match the title bar / workspace sidebar so when the iframe's
      // top-left corner is rounded, the pixel revealed behind it
      // continues the L-shape chrome (title bar + sidebar) rather
      // than showing the lighter panel background.
      style={{ background: "var(--zenbu-chrome)" }}
    >
      <ViewCacheSlot
        cacheKey={cacheKey}
        src={src}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
        iframeStyle={{
          borderTopLeftRadius: "8px",
          borderTop: "1px solid var(--zenbu-panel-border)",
          borderLeft: "1px solid var(--zenbu-panel-border)",
          borderRight: "1px solid var(--zenbu-panel-border)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function ConnectedApp({
  connection,
}: {
  connection: Extract<WsConnectionState, { status: "connected" }>;
}) {
  return (
    <RpcProvider value={connection.rpc}>
      <EventsProvider value={connection.events}>
        <KyjuClientProvider value={connection.kyjuClient}>
          <KyjuProvider
            client={connection.kyjuClient}
            replica={connection.replica}
          >
            <ShortcutForwarderProvider windowId={windowId!}>
              <OrchestratorContent />
              <DragRegionOverlay />
            </ShortcutForwarderProvider>
          </KyjuProvider>
        </KyjuClientProvider>
      </EventsProvider>
    </RpcProvider>
  );
}

export function App() {
  const connection = useWsConnection();

  if (connection.status === "connecting") {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500 text-xs"></div>
    );
  }

  if (connection.status === "error") {
    return (
      <div className="flex h-full items-center justify-center text-red-400 text-xs">
        {connection.error}
      </div>
    );
  }

  return (
    <ErrorBoundary
      scope="root"
      fallback={({ error, reset }) => (
        <FullErrorFallback error={error} onReset={reset} />
      )}
    >
      <ConnectedApp connection={connection} />
    </ErrorBoundary>
  );
}
