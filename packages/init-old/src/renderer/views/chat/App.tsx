import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCollection, useDb } from "../../lib/kyju-react";
import { useDragRegion } from "../../lib/drag-region";
import { useRpc } from "../../lib/providers";
import { ViewProvider, useViewProps } from "../../lib/View";
import { ChatDisplay } from "./ChatDisplay";
import { ComposerPanel } from "./ComposerPanel";
import { MinimapContent } from "./components/MinimapContent";
import type { ExpectedVisibleMessage } from "./lib/chat-invariants";

type BoundaryState = { error: Error | null; componentStack: string | null };

class ChatErrorBoundary extends Component<
  { children: ReactNode; label?: string; compact?: boolean },
  BoundaryState
> {
  state: BoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error(
      `[chat-view${this.props.label ? `:${this.props.label}` : ""}] Uncaught error:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          label={this.props.label}
          compact={this.props.compact}
          onReset={() => this.setState({ error: null, componentStack: null })}
        />
      );
    }
    return this.props.children;
  }
}

export { ChatErrorBoundary };

function ErrorFallback({
  error,
  componentStack,
  label,
  compact,
  onReset,
}: {
  error: Error;
  componentStack: string | null;
  label?: string;
  compact?: boolean;
  onReset: () => void;
}) {
  const [showStack, setShowStack] = useState(false);

  if (compact) {
    return (
      <div className="mx-3 my-1 rounded border border-red-200 bg-red-50 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-red-700">
              {label ? `${label} crashed` : "Render error"}
            </div>
            <div className="text-[11px] text-red-600 font-mono break-all">
              {error.message}
            </div>
          </div>
          <button
            onClick={onReset}
            className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-200 cursor-pointer"
          >
            Retry
          </button>
        </div>
        {(error.stack || componentStack) && (
          <button
            onClick={() => setShowStack((s) => !s)}
            className="mt-1 text-[10px] text-red-500 hover:text-red-700 cursor-pointer"
          >
            {showStack ? "Hide" : "Show"} details
          </button>
        )}
        {showStack && (
          <div className="mt-1 space-y-1">
            {componentStack && (
              <pre className="max-h-32 overflow-auto rounded bg-white p-2 text-[10px] text-neutral-600 leading-relaxed">
                <span className="text-neutral-400">component stack:</span>
                {componentStack}
              </pre>
            )}
            {error.stack && (
              <pre className="max-h-32 overflow-auto rounded bg-white p-2 text-[10px] text-neutral-600 leading-relaxed">
                <span className="text-neutral-400">error stack:</span>
                {"\n"}
                {error.stack}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-(--zenbu-panel) p-8">
      <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-red-200 bg-white p-6 shadow-sm">
        <div className="text-sm font-medium text-red-600">
          {label ? `${label} crashed` : "Something went wrong"}
        </div>
        <div className="text-xs text-neutral-600 font-mono break-all">{error.message}</div>
        {(error.stack || componentStack) && (
          <button
            onClick={() => setShowStack((s) => !s)}
            className="text-xs text-neutral-400 hover:text-neutral-600 text-left cursor-pointer"
          >
            {showStack ? "Hide" : "Show"} details
          </button>
        )}
        {showStack && componentStack && (
          <pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-3 text-[10px] text-neutral-500 leading-relaxed">
            <span className="text-neutral-400">component stack:</span>
            {componentStack}
          </pre>
        )}
        {showStack && error.stack && (
          <pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-3 text-[10px] text-neutral-500 leading-relaxed">
            <span className="text-neutral-400">error stack:</span>
            {"\n"}
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

const searchParams = new URLSearchParams(window.location.search);
const viewId = searchParams.get("viewId") ?? "";
const isMinimap = searchParams.get("minimap") === "true";
const envWindowId = searchParams.get("windowId") ?? "";
const envWorkspaceId = searchParams.get("workspaceId") ?? "";

let triggerExplosion: (() => void) | null = null;
(window as any).explode = () => {
  if (triggerExplosion) triggerExplosion();
  else console.warn("[chat-view] No explosion hook mounted yet");
};

function ExplosionTrap() {
  const [explode, setExplode] = useState(false);
  triggerExplosion = () => setExplode(true);
  if (explode) throw new Error("Manual explosion triggered from console");
  return null;
}

const CHAT_TITLE_BAR_HEIGHT = 36;
const CHAT_TITLE_FADE_HEIGHT = 16;

function ChatContent() {
  const props = useViewProps();
  const agentId = props.agentId ?? "";
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const expectedVisibleMessageRef = useRef<ExpectedVisibleMessage | null>(null);

  if (isMinimap) {
    return <MinimapContent agentId={agentId} />
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-(--zenbu-panel) relative">
      <ExplosionTrap />
      <ChatTitleBar agentId={agentId} />
      <div className="@container relative flex flex-1 min-h-0 min-w-0 flex-col">
        <ChatDisplay
          agentId={agentId}
          scrollToBottomRef={scrollToBottomRef}
          debugExpectedVisibleMessageRef={expectedVisibleMessageRef}
        />
        {/* Scroll-fade band: a thin gradient just below the title bar so
            content scrolling up dissolves into the chrome rather than
            slamming into the opaque title bar. Pointer-events:none keeps
            it click-through. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-0"
          style={{
            height: CHAT_TITLE_FADE_HEIGHT,
            background:
              "linear-gradient(to bottom, var(--zenbu-panel), color-mix(in srgb, var(--zenbu-panel) 0%, transparent))",
            zIndex: 5,
          }}
        />
        <ComposerPanel
          agentId={agentId}
          viewId={viewId}
          scrollToBottom={() => scrollToBottomRef.current?.()}
          debugExpectedVisibleMessageRef={expectedVisibleMessageRef}
        />
      </div>
    </div>
  );
}

function ChatTitleBar({ agentId }: { agentId: string }) {
  const dragRef = useDragRegion<HTMLDivElement>();
  const rpc = useRpc();
  const agent = useDb((root) =>
    root.plugin.kernel.agents.find((a) => a.id === agentId),
  );
  const { items: events } = useCollection(agent?.eventLog);

  const shellViewId =
    envWindowId && envWorkspaceId
      ? `workspace:${envWindowId}:${envWorkspaceId}`
      : null;
  const sidebarOpen = useDb((root) =>
    shellViewId
      ? (root.plugin["agent-manager"].workspaceShellState[shellViewId]
          ?.sidebarOpen ?? true)
      : true,
  );
  const showSidebarToggle = !!shellViewId && !sidebarOpen;
  const onToggleSidebar = () => {
    if (!envWindowId || !envWorkspaceId) return;
    void rpc["agent-manager"]
      .setSidebar({ windowId: envWindowId, workspaceId: envWorkspaceId })
      .catch((err: unknown) => {
        console.error("[chat-view] setSidebar failed", err);
      });
  };

  const lastUserPrompt = useMemo(() => {
    let text: string | undefined;
    for (const e of events) {
      if (e?.data?.kind === "user_prompt") text = e.data.text;
    }
    return text;
  }, [events]);

  const title = agent?.title;
  const summary =
    title?.kind === "set"
      ? title.value
      : title?.kind === "generating"
        ? "…"
        : lastUserPrompt?.replace(/\s+/g, " ").trim() || "";
  const cwd =
    typeof agent?.metadata?.cwd === "string" ? agent.metadata.cwd : "";
  const project = cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "";

  return (
    <div
      className="shrink-0 flex items-center bg-(--zenbu-panel) relative z-10"
      style={{
        height: CHAT_TITLE_BAR_HEIGHT,
        paddingLeft: 0,
        paddingRight: 8,
      }}
    >
      {showSidebarToggle && (
        <div
          className="shrink-0 flex items-center"
          style={{ paddingLeft: 8, paddingRight: 4 }}
        >
          <SidebarOpenButton onClick={onToggleSidebar} />
        </div>
      )}
      <div
        ref={dragRef}
        className="flex-1 min-w-0 self-stretch flex items-center"
        style={{ paddingLeft: showSidebarToggle ? 0 : 12 }}
      >
        <div
          className="min-w-0 flex items-baseline gap-1.5 text-[12px] text-muted-foreground"
          style={{
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {project && (
            <>
              <span className="text-foreground shrink-0" title={cwd}>
                {project}
              </span>
              <span className="text-muted-foreground shrink-0">/</span>
            </>
          )}
          <span
            className="text-muted-foreground"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: title?.kind === "generating" ? 0.5 : 1,
            }}
            title={summary}
          >
            {summary}
          </span>
        </div>
      </div>
    </div>
  );
}

function SidebarOpenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show sidebar"
      className="inline-flex items-center justify-center rounded text-neutral-500 cursor-pointer hover:bg-black/10 hover:text-neutral-700 transition-colors"
      style={{ width: 22, height: 22 }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>
  );
}

export function App() {
  return (
    <ViewProvider
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm" />
      }
    >
      <ChatErrorBoundary>
        <ChatContent />
      </ChatErrorBoundary>
    </ViewProvider>
  );
}
