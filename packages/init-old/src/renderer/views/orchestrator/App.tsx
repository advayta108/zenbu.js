import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  RotateCwIcon,
  DownloadIcon,
  GitMergeIcon,
  RefreshCwIcon,
} from "lucide-react";
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
import { View } from "../../lib/View";

const params = new URLSearchParams(window.location.search);
const wsToken = params.get("wsToken") ?? "";
const windowId = params.get("windowId");
if (!windowId) throw new Error("Missing ?windowId= in orchestrator URL");
if (!wsToken) throw new Error("Missing ?wsToken= in orchestrator URL");

type ErrorFallbackRender = (args: {
  error: Error;
  reset: () => void;
}) => ReactNode;

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

function TitleBar() {
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
      </div>
    </>
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
  const client = useKyjuClient();

  const ensuredRef = useRef(false);

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
        },
      };
    });
  }, [client]);

  const rootFocusRef = useRef<HTMLDivElement>(null);
  useFocusOnRequest("orchestrator", () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    rootFocusRef.current?.focus();
  });

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
        <TitleBar />
      </ErrorBoundary>
      <KernelBinaryUpdateBanner />
      <div className="flex-1 min-h-0 relative">
        <ErrorBoundary
          scope="app-shell-view"
          fallback={({ error, reset }) => (
            <FullErrorFallback error={error} onReset={reset} />
          )}
        >
          <View
            id="app-shell"
            scope="agent-manager"
            persisted
            pinned
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            iframeStyle={{
              borderTop: "1px solid var(--zenbu-panel-border)",
              boxSizing: "border-box",
            }}
          />
        </ErrorBoundary>
      </div>
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
