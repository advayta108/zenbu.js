import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
  lazy,
  Suspense,
} from "react";
import {
  RotateCwIcon,
  DownloadIcon,
  GitMergeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useDb } from "../../lib/kyju-react";
import { ViewProvider } from "../../lib/View";
import { useKyjuClient, useRpc } from "../../lib/providers";
import { DragRegionOverlay } from "../../lib/drag-region";
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
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { View } from "../../lib/View";

const params = new URLSearchParams(window.location.search);
const wsPort = Number(params.get("wsPort"));
const wsToken = params.get("wsToken") ?? "";
const windowId = params.get("windowId");
const defaultCwd = params.get("defaultCwd") ?? "";
if (!windowId) throw new Error("Missing ?windowId= in orchestrator URL");
if (!wsToken) throw new Error("Missing ?wsToken= in orchestrator URL");

import type { SchemaRoot } from "../../../../shared/schema";

type RegistryEntry = { scope: string; url: string; port: number };

// The workspace shell view's id is fully derived from (windowId,
// workspaceId), so the orchestrator title bar and the workspace iframe
// can both point at the same `viewState` row without coordination.
function workspaceShellViewId(windowId: string, workspaceId: string): string {
  return `workspace:${windowId}:${workspaceId}`;
}

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

const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);

function TitleBar({
  workspaceLabel,
  onToggleChatPanel,
  chatPanelVisible,
}: {
  workspaceLabel: string;
  onToggleChatPanel: (() => void) | null;
  chatPanelVisible?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialSection="general"
          />
        </Suspense>
      )}
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
          <SettingsButton onClick={() => setSettingsOpen(true)} />
          <ReloadMenu />
        </div>
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          title={workspaceLabel}
        >
          <span className="truncate max-w-[60%] text-[12px] text-neutral-600 font-medium px-2">
            {workspaceLabel}
          </span>
        </div>
        {onToggleChatPanel && (
          <div
            className="ml-auto flex items-center relative"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <ChatPanelToggle
              onClick={onToggleChatPanel}
              active={chatPanelVisible}
            />
          </div>
        )}
      </div>
    </>
  );
}

function ChatPanelToggle({
  onClick,
  active,
}: {
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? "Close chat" : "Open chat"}
      className={`inline-flex items-center justify-center rounded text-neutral-500 cursor-pointer hover:bg-black/10 hover:text-neutral-700 transition-colors ${
        active ? "bg-black/10 text-neutral-700" : ""
      }`}
      style={{ width: 22, height: 22 }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Settings"
      className="inline-flex items-center justify-center rounded text-neutral-500 cursor-pointer hover:bg-black/10 hover:text-neutral-700 transition-colors"
      style={{ width: 22, height: 22 }}
    >
      <SettingsGearIcon />
    </button>
  );
}

function SettingsGearIcon() {
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
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function OrchestratorContent() {
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

  const activeViewId = useDb(
    (root) => root.plugin.kernel.windowState[windowId!]?.activeViewId ?? null,
  );

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

  // ---- inline chat panel state ----

  // The chat panel toggles when `activeWorkspace.viewScope !== "agent-manager"`.
  // null means "no chat toggle available" (workspace already shows agent-manager).
  const showChatToggle = !!activeWorkspace;

  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const chatPanelWidth = chatPanelWidthStore.useWidth();
  const [chatPanelResizing, setChatPanelResizing] = useState(false);

  // Optimistic mirror: read from kyju state if one already exists for
  // this workspace. If not, we create it on first toggle-open.
  const existingMirrorId = useDb((root) => {
    if (!activeWorkspaceId) return null;
    const ws = (root.plugin.kernel.workspaces ?? []).find(
      (w) =>
        w.mirrorOfWorkspaceId === activeWorkspaceId && w.hidden,
    );
    return ws?.id ?? null;
  });
  const [createdMirrorId, setCreatedMirrorId] = useState<string | null>(null);
  const mirrorWorkspaceId = existingMirrorId ?? createdMirrorId;

  // Reset chat panel when workspace changes.
  const prevWorkspaceRef = useRef(activeWorkspaceId);
  useEffect(() => {
    if (activeWorkspaceId !== prevWorkspaceRef.current) {
      prevWorkspaceRef.current = activeWorkspaceId;
      setChatPanelOpen(false);
      setCreatedMirrorId(null);
    }
  }, [activeWorkspaceId]);

  const handleToggleChatPanel = useCallback(() => {
    setChatPanelOpen((prev) => {
      const next = !prev;
      if (next && !mirrorWorkspaceId && activeWorkspaceId) {
        void rpc.workspace
          .ensureMirrorWorkspace(activeWorkspaceId)
          .then(({ mirrorWorkspaceId: id }) => setCreatedMirrorId(id))
          .catch((err: unknown) => {
            console.error("[orchestrator] ensureMirrorWorkspace failed:", err);
          });
      }
      return next;
    });
  }, [rpc, activeWorkspaceId, mirrorWorkspaceId]);

  const onToggleChatPanel = showChatToggle ? handleToggleChatPanel : null;

  const rootFocusRef = useRef<HTMLDivElement>(null);
  useFocusOnRequest("orchestrator", () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    rootFocusRef.current?.focus();
  });

  void workspaceCwds;
  void defaultCwd;

  const chatPanelVisible = chatPanelOpen && showChatToggle && !!mirrorWorkspaceId;

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
          workspaceLabel={activeWorkspace?.name ?? ""}
          onToggleChatPanel={onToggleChatPanel}
          chatPanelVisible={chatPanelVisible}
        />
      </ErrorBoundary>
      <KernelBinaryUpdateBanner />
      <div className="flex flex-row flex-1 min-h-0">
        {!activeWorkspace?.hidden && (
          <WorkspaceSidebar
            windowId={windowId!}
            activeWorkspaceId={activeWorkspaceId ?? null}
            onSelectWorkspace={handleSelectWorkspace}
          />
        )}
        <ErrorBoundary
          scope="workspace-view"
          fallback={({ error, reset }) => (
            <FullErrorFallback error={error} onReset={reset} />
          )}
        >
          <WorkspaceFrame
            workspaceId={activeWorkspaceId ?? null}
            windowId={windowId!}
          />
        </ErrorBoundary>
        {chatPanelVisible && (
          <>
            <ChatPanelResizeHandle
              onResizeChange={setChatPanelResizing}
              store={chatPanelWidthStore}
            />
            {chatPanelResizing && <ChatPanelResizeOverlay />}
            <ChatPanel
              mirrorWorkspaceId={mirrorWorkspaceId}
              windowId={windowId!}
              width={chatPanelWidth}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---- chat panel width store (localStorage-backed) ----

const CHAT_PANEL_STORAGE_KEY = "chat-panel:width";
const CHAT_PANEL_DEFAULT = 440;

function makeChatPanelWidthStore() {
  const listeners = new Set<() => void>();
  let memo: number | null = null;
  function read(): number {
    if (memo !== null) return memo;
    try {
      const raw = localStorage.getItem(CHAT_PANEL_STORAGE_KEY);
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) {
          memo = n;
          return memo;
        }
      }
    } catch {}
    memo = CHAT_PANEL_DEFAULT;
    return memo;
  }
  function get(): number {
    return read();
  }
  function set(next: number) {
    const clamped = Math.max(280, Math.round(next));
    if (clamped === memo) return;
    memo = clamped;
    try {
      localStorage.setItem(CHAT_PANEL_STORAGE_KEY, String(clamped));
    } catch {}
    for (const l of listeners) l();
  }
  function useWidth(): number {
    return useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      read,
      read,
    );
  }
  return { get, set, useWidth };
}

const chatPanelWidthStore = makeChatPanelWidthStore();

// ---- chat panel components ----

function ChatPanel({
  mirrorWorkspaceId,
  windowId,
  width,
}: {
  mirrorWorkspaceId: string;
  windowId: string;
  width: number;
}) {
  const shellViewId = `chat-panel:${windowId}:${mirrorWorkspaceId}`;
  return (
    <div
      className="shrink-0 flex flex-col overflow-hidden relative"
      style={{
        width,
        borderTop: "1px solid var(--zenbu-panel-border)",
      }}
    >
      <View
        id={shellViewId}
        scope="agent-manager"
        props={{ workspaceId: mirrorWorkspaceId }}
        persisted
        pinned
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}

function ChatPanelResizeHandle({
  onResizeChange,
  store,
}: {
  onResizeChange: (resizing: boolean) => void;
  store: { get: () => number; set: (v: number) => void };
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = store.get();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      onResizeChange(true);
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        store.set(startWidth - delta);
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeChange(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onResizeChange, store],
  );
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
  );
}

function ChatPanelResizeOverlay() {
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
  );
}

function WorkspaceFrame({
  workspaceId,
  windowId,
}: {
  workspaceId: string | null;
  windowId: string;
}) {
  // Each workspace declares which registered view scope provides its shell.
  // Defaults to "agent-manager"; if a future plugin registers an alternative
  // workspace shell with `meta.kind === "workspace-shell"`, a workspace can
  // point at it by setting `viewScope` on its row.
  // Two separate `useDb` calls so each returns a primitive (otherwise
  // returning a fresh object every snapshot would loop useSyncExternalStore).
  const viewScope = useDb((root) => {
    if (!workspaceId) return "agent-manager";
    const ws = (root.plugin.kernel.workspaces ?? []).find(
      (w) => w.id === workspaceId,
    );
    return ws?.viewScope ?? "agent-manager";
  });
  const isHidden = useDb((root) => {
    if (!workspaceId) return false;
    const ws = (root.plugin.kernel.workspaces ?? []).find(
      (w) => w.id === workspaceId,
    );
    return ws?.hidden ?? false;
  });

  if (!workspaceId) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center text-neutral-400 text-xs">
        {/* Pick or create a workspace */}
      </div>
    );
  }
  // Hidden workspaces (agent-window mirrors) render without the workspace
  // sidebar, so the iframe occupies the full window width. Drop the
  // top-left rounding + the left border so the iframe is flush with the
  // window chrome — same flat treatment as the top-right edge.
  const iframeStyle: React.CSSProperties = isHidden
    ? {
        borderTop: "1px solid var(--zenbu-panel-border)",
        borderRight: "1px solid var(--zenbu-panel-border)",
        boxSizing: "border-box",
      }
    : {
        borderTopLeftRadius: "8px",
        borderTop: "1px solid var(--zenbu-panel-border)",
        borderLeft: "1px solid var(--zenbu-panel-border)",
        borderRight: "1px solid var(--zenbu-panel-border)",
        boxSizing: "border-box",
      };
  return (
    <div
      className="flex-1 min-w-0 min-h-0 relative"
      // Match the title bar / workspace sidebar so when the iframe's
      // top-left corner is rounded, the pixel revealed behind it
      // continues the L-shape chrome (title bar + sidebar) rather
      // than showing the lighter panel background.
      style={{ background: "var(--zenbu-chrome)" }}
    >
      <View
        id={workspaceShellViewId(windowId, workspaceId)}
        scope={viewScope}
        props={{ workspaceId }}
        persisted
        pinned
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
        iframeStyle={iframeStyle}
      />
    </div>
  );
}

export function App() {
  return (
    <ViewProvider
      fallback={
        <div className="flex h-full items-center justify-center text-neutral-500 text-xs" />
      }
      errorFallback={(error) => (
        <div className="flex h-full items-center justify-center text-red-400 text-xs">
          {error}
        </div>
      )}
    >
      <ErrorBoundary
        scope="root"
        fallback={({ error, reset }) => (
          <FullErrorFallback error={error} onReset={reset} />
        )}
      >
        <ShortcutForwarderProvider windowId={windowId!}>
          <OrchestratorContent />
          <DragRegionOverlay />
        </ShortcutForwarderProvider>
      </ErrorBoundary>
    </ViewProvider>
  );
}
