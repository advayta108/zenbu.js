import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { KyjuProvider, useDb } from "./kyju-react";
import {
  EventsProvider,
  KyjuClientProvider,
  RpcProvider,
  useKyjuClient,
} from "./providers";
import { useWsConnection, type WsConnectionState } from "./ws-connection";

// ---------------------------------------------------------------------------
// View primitive: one component for every iframe in the app.
//
// Two flavors of usage:
//
//   1. Persisted (chat tabs, anything user-managed):
//      <View id={tab.id} scope="chat" props={{ agentId }} persisted pinned />
//      The View writes/reconciles a row in kernel.views[id] with the given
//      scope+props. Child reads props reactively via useViewProps() backed
//      by a kyju subscription. Survives reload.
//
//   2. Ephemeral (workspace shell, utility sidebar, anything render-bound):
//      <View id="workspace-shell:<windowId>" scope="workspace" props={{...}} />
//      No kyju row written. Props ride the URL query string. Child still
//      reads them via useViewProps() (URL fallback path).
//
// The View component is responsible for:
//   - Looking up the registry entry for `scope` to resolve the iframe URL.
//   - Inheriting wsPort/wsToken/windowId/workspaceId from the current
//     iframe's URL (caller doesn't pass these).
//   - Mounting the iframe through a body-level container so style/scroll
//     state survives mount/unmount transitions across pinned views.
//   - LRU-evicting unpinned iframes when the cache exceeds VIEW_CACHE_CAP.
//   - Recording cache state in viewState[id].cachedAt for observability.
//
// The agent sidebar (AgentList) etc. iterate kernel.views directly; persisted
// chat-tab rows show up there, ephemeral system views do not.
// ---------------------------------------------------------------------------

const VIEW_CACHE_CAP = 8;

// Props the child can never override on its own URL: they're always
// inherited from the parent iframe (connection plumbing + identity).
// Everything else — including `workspaceId` — flows through the normal
// caller-props path, which makes those values just-another-prop in the
// mental model: discoverable via `useViewProps()`, reactive when the
// view is persisted, seedable by the parent.
const INHERITED_ONLY_KEYS = new Set([
  "wsPort",
  "wsToken",
  "windowId",
  "viewId",
]);

type Entry = {
  id: string;
  src: string;
  iframe: HTMLIFrameElement;
  ready: Promise<void>;
  resolveReady: () => void;
  claimedBy: string | null;
  onLoadCallbacks: Set<(win: Window) => void>;
  pinned: boolean;
  lastTouched: number;
};

const cache = new Map<string, Entry>();
let warnedOverCap = false;
let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && container.isConnected) return container;
  const el = document.createElement("div");
  el.setAttribute("data-view-cache-container", "");
  Object.assign(el.style, {
    position: "fixed",
    top: "0px",
    left: "0px",
    width: "0px",
    height: "0px",
    pointerEvents: "none",
    zIndex: "0",
    overflow: "visible",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  container = el;
  return el;
}

function createEntry(id: string, src: string): Entry {
  const host = ensureContainer();
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.setAttribute("data-view-id", id);
  Object.assign(iframe.style, {
    position: "absolute",
    border: "none",
    top: "0px",
    left: "0px",
    width: "0px",
    height: "0px",
    visibility: "hidden",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  host.appendChild(iframe);

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const entry: Entry = {
    id,
    src,
    iframe,
    ready,
    resolveReady,
    claimedBy: null,
    onLoadCallbacks: new Set(),
    pinned: false,
    lastTouched: Date.now(),
  };
  iframe.addEventListener("load", () => {
    entry.resolveReady();
    const win = iframe.contentWindow;
    if (win) {
      for (const cb of entry.onLoadCallbacks) {
        try {
          cb(win);
        } catch (err) {
          console.error("[view] onLoad callback failed", err);
        }
      }
    }
  });
  return entry;
}

function evictCacheEntry(id: string): void {
  const e = cache.get(id);
  if (!e) return;
  e.iframe.remove();
  cache.delete(id);
}

function evictIfOverCap(): string[] {
  if (cache.size <= VIEW_CACHE_CAP) return [];
  const evicted: string[] = [];
  const candidates = [...cache.values()]
    .filter((e) => !e.pinned && e.claimedBy === null)
    .sort((a, b) => a.lastTouched - b.lastTouched);
  while (cache.size > VIEW_CACHE_CAP && candidates.length > 0) {
    const oldest = candidates.shift()!;
    evictCacheEntry(oldest.id);
    evicted.push(oldest.id);
  }
  if (cache.size > VIEW_CACHE_CAP && !warnedOverCap) {
    warnedOverCap = true;
    console.warn(
      `[view] cache size ${cache.size} exceeds cap ${VIEW_CACHE_CAP}; ` +
        `all entries are pinned or claimed`,
    );
  }
  return evicted;
}

function positionIframeOver(entry: Entry, rect: DOMRect): void {
  const iframe = entry.iframe;
  iframe.style.top = `${rect.top}px`;
  iframe.style.left = `${rect.left}px`;
  iframe.style.width = `${rect.width}px`;
  iframe.style.height = `${rect.height}px`;
  iframe.style.visibility = "visible";
  iframe.style.pointerEvents = "auto";
}

function hideIframe(entry: Entry): void {
  const iframe = entry.iframe;
  iframe.style.width = "0px";
  iframe.style.height = "0px";
  iframe.style.visibility = "hidden";
  iframe.style.pointerEvents = "none";
}

/**
 * Get the live iframe element for a cached id (e.g. to call `.focus()`).
 * Returns null if the iframe has been LRU-evicted or never mounted.
 */
export function getViewIframe(id: string): HTMLIFrameElement | null {
  return cache.get(id)?.iframe ?? null;
}

// ---------------------------------------------------------------------------
// Env inheritance: every iframe in this app is loaded with these query keys.
// The current iframe's URL is the source; new child iframes get the same
// values (so connection bits and window/workspace context are transparent
// to callers of <View>).
// ---------------------------------------------------------------------------

type Env = {
  wsPort: string;
  wsToken: string;
  windowId: string;
  workspaceId: string | null;
};

let cachedEnv: Env | null = null;
function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const params = new URLSearchParams(window.location.search);
  cachedEnv = {
    wsPort: params.get("wsPort") ?? "",
    wsToken: params.get("wsToken") ?? "",
    windowId: params.get("windowId") ?? "",
    workspaceId: params.get("workspaceId") ?? null,
  };
  return cachedEnv;
}

function buildChildUrl(args: {
  id: string;
  registryUrl: string;
  registryPort: number;
  props: Record<string, string>;
  env: Env;
}): string {
  const { id, registryUrl, registryPort, props, env } = args;
  let entryPath = new URL(registryUrl).pathname;
  const ownsServer = entryPath === "/" || entryPath === "";
  if (ownsServer) entryPath = "";
  else if (entryPath.endsWith("/")) entryPath = entryPath.slice(0, -1);
  // Always route directly to the entry's own reloader port. The kernel
  // HTTP proxy only forwards to `core`, so aliases on a non-core reloader
  // (e.g. agent-manager hosting workspace/new-agent/plugins on its own
  // Vite) would 404 if we routed through `wsPort`. Going direct works for
  // both core-aliased entries (same Vite, same port) and non-core ones.
  const targetPort = registryPort;
  // Per-view subdomain so each iframe gets its own Origin (cookies,
  // localStorage, etc.).
  const hostname = id.toLowerCase().replace(/[^a-z0-9]/g, "");

  const qs = new URLSearchParams();
  qs.set("viewId", id);
  qs.set("wsPort", env.wsPort);
  qs.set("wsToken", env.wsToken);
  qs.set("windowId", env.windowId);
  // workspaceId: caller props win, env is the fallback. The orchestrator
  // iframe has no workspaceId in its own URL (workspaces activate after
  // the window opens), so when it mounts <WorkspaceFrame>, the workspace
  // id arrives via props. Without this override, the workspace iframe
  // loads with no ?workspaceId=, which both breaks per-workspace theme
  // injection and disables workspace-scoped advice filtering (advice
  // from one workspace's plugin leaks into other workspaces' iframes).
  const workspaceId = props.workspaceId ?? env.workspaceId;
  if (workspaceId) qs.set("workspaceId", workspaceId);
  for (const [k, v] of Object.entries(props)) {
    if (INHERITED_ONLY_KEYS.has(k)) continue; // env-only, caller can't override
    if (k === "workspaceId") continue; // already written above
    qs.set(k, v);
  }

  return `http://${hostname}.localhost:${targetPort}${entryPath}/index.html?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// View component.
// ---------------------------------------------------------------------------

export type ViewProps = {
  /** Stable cache key. For persisted views, also the kyju row id. */
  id: string;
  /** Registry scope used to resolve the iframe URL. */
  scope: string;
  /** App-level data. Forwarded to the child via URL query string and (when
   *  persisted) reactively via kyju. */
  props?: Record<string, string>;
  /** When true, write/reconcile a row in kernel.views[id] so the view is
   *  enumerated by the agent sidebar / persists across reloads. Default
   *  false (ephemeral). */
  persisted?: boolean;
  /** Immune from LRU eviction (active views in tab-like UIs). */
  pinned?: boolean;
  /** Visually hidden; iframe stays in cache. */
  hidden?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Style applied to the floating iframe element (e.g. borderRadius). */
  iframeStyle?: CSSProperties;
  /** Fires once the iframe's contentWindow is ready. */
  onLoad?: (win: Window) => void;
};

export function View({
  id,
  scope,
  props,
  persisted,
  pinned,
  hidden,
  className,
  style,
  iframeStyle,
  onLoad,
}: ViewProps): ReactElement {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const slotId = useId();
  const client = useKyjuClient();

  // Resolve the registry entry for this scope. Reactive: if the entry
  // arrives later (plugin booted late), we pick it up.
  const registryEntry = useDb((root) => {
    return (
      root.plugin.kernel.viewRegistry.find((r) => r.scope === scope) ?? null
    );
  });

  // Build the iframe URL once we have a registry entry.
  const propsKey = useMemo(
    () => JSON.stringify(props ?? {}),
    [props],
  );
  const src = useMemo(() => {
    if (!registryEntry) return null;
    return buildChildUrl({
      id,
      registryUrl: registryEntry.url,
      registryPort: registryEntry.port,
      props: props ?? {},
      env: getEnv(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, registryEntry?.url, registryEntry?.port, propsKey]);

  // Persistence: write/reconcile the kyju row + matching viewState entry.
  // Persisted views are the only ones that can park UI state on
  // viewState[id] (sidebarOpen, draft, order, utilitySidebarSelected, …),
  // so we seed an empty viewState row alongside the entity. cachedAt is
  // managed by the cache layer below.
  useEffect(() => {
    if (!persisted) return;
    void client.update((root) => {
      const k = root.plugin.kernel;
      const existing = k.views.find((v) => v.id === id);
      const env = getEnv();
      if (!existing) {
        k.views = [
          ...k.views,
          {
            id,
            windowId: env.windowId,
            parentId: null,
            scope,
            props: props ?? {},
            createdAt: Date.now(),
          },
        ];
      } else {
        // Reconcile scope/props if caller has updated them.
        const nextProps = props ?? {};
        const sameProps =
          Object.keys(existing.props).length ===
            Object.keys(nextProps).length &&
          Object.entries(nextProps).every(([k2, v]) => existing.props[k2] === v);
        if (existing.scope !== scope || !sameProps) {
          k.views = k.views.map((v) =>
            v.id === id ? { ...v, scope, props: nextProps } : v,
          );
        }
      }
      if (!k.viewState[id]) {
        k.viewState = {
          ...k.viewState,
          [id]: {
            viewId: id,
            draft: null,
            pendingCwd: null,
            order: 0,
            cachedAt: null,
            loadedAt: null,
            loadCount: 0,
            loadError: null,
          },
        };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted, id, scope, propsKey]);

  // Cache management: claim or create the iframe entry.
  useLayoutEffect(() => {
    if (!src) return;
    let entry = cache.get(id);
    if (!entry) {
      entry = createEntry(id, src);
      cache.set(id, entry);
      writeCachedAt(client, id, Date.now());
    } else if (entry.src !== src) {
      // URL changed (props serialized into URL changed). Replace the
      // iframe to force a reload with the new query string.
      evictCacheEntry(id);
      entry = createEntry(id, src);
      cache.set(id, entry);
      writeCachedAt(client, id, Date.now());
    }
    entry.pinned = !!pinned;
    entry.lastTouched = Date.now();
    entry.claimedBy = slotId;

    const el = placeholderRef.current;
    if (!el) return;

    const apply = () => {
      const cur = cache.get(id);
      if (!cur || cur.claimedBy !== slotId) return;
      if (hidden) {
        hideIframe(cur);
        return;
      }
      positionIframeOver(cur, el.getBoundingClientRect());
      if (iframeStyle) {
        Object.assign(
          cur.iframe.style,
          iframeStyle as Record<string, string>,
        );
      }
    };
    apply();

    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("scroll", apply, true);
    window.addEventListener("resize", apply);

    // Run LRU eviction after claim. Pinned + claimed entries are protected,
    // so we never evict the iframe we just mounted.
    const evicted = evictIfOverCap();
    if (evicted.length > 0) {
      for (const evictedId of evicted) {
        writeCachedAt(client, evictedId, null);
      }
    }

    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", apply, true);
      window.removeEventListener("resize", apply);
      const cur = cache.get(id);
      if (cur && cur.claimedBy === slotId) {
        cur.claimedBy = null;
        hideIframe(cur);
        if (iframeStyle) {
          for (const key of Object.keys(iframeStyle)) {
            (cur.iframe.style as unknown as Record<string, string>)[key] = "";
          }
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, src, pinned, hidden, slotId, iframeStyle]);

  // onLoad callback registration. Re-runs whenever the callback identity
  // changes; fires immediately if the iframe has already loaded.
  useEffect(() => {
    if (!onLoad) return;
    const entry = cache.get(id);
    if (!entry) return;
    entry.onLoadCallbacks.add(onLoad);
    void entry.ready.then(() => {
      const win = entry.iframe.contentWindow;
      if (win)
        try {
          onLoad(win);
        } catch (err) {
          console.error("[view] onLoad (ready) failed", err);
        }
    });
    return () => {
      entry.onLoadCallbacks.delete(onLoad);
    };
  }, [id, onLoad]);

  // Persisted views write load-debug fields so the view-debug plugin (and
  // anything else watching `viewState[id]`) can tell loaded vs loading.
  // Each iframe `load` event bumps `loadCount` + sets `loadedAt`; we
  // also fire once on attach if the entry has already loaded so a
  // late-mounting <View> still records "yes, this thing is up".
  useEffect(() => {
    if (!persisted) return;
    const entry = cache.get(id);
    if (!entry) return;
    const tracker = () => {
      writeLoadDebug(client, id, {
        loadedAt: Date.now(),
        loadError: null,
        bumpCount: true,
      });
    };
    entry.onLoadCallbacks.add(tracker);
    void entry.ready.then(tracker);
    return () => {
      entry.onLoadCallbacks.delete(tracker);
    };
  }, [persisted, id, client]);

  return (
    <div
      ref={placeholderRef}
      className={className}
      style={{ position: "relative", ...style }}
      data-view-slot={id}
    />
  );
}

function writeCachedAt(
  client: ReturnType<typeof useKyjuClient>,
  viewId: string,
  cachedAt: number | null,
): void {
  void client.update((root) => {
    const cur = root.plugin.kernel.viewState[viewId];
    if (!cur) return; // no viewState entry; skip (system/ephemeral views)
    if (cur.cachedAt === cachedAt) return;
    // (Re-)creating the cache entry resets load tracking. The iframe
    // hasn't fired its load event for this fresh src yet; clear stale
    // loadedAt + loadError so observers see "loading" until the first
    // load event ticks them through.
    const reset =
      cachedAt !== null && cur.cachedAt === null
        ? { loadedAt: null, loadError: null }
        : cachedAt === null
          ? { loadedAt: null }
          : null;
    root.plugin.kernel.viewState = {
      ...root.plugin.kernel.viewState,
      [viewId]: { ...cur, cachedAt, ...(reset ?? {}) },
    };
  });
}

function writeLoadDebug(
  client: ReturnType<typeof useKyjuClient>,
  viewId: string,
  patch: { loadedAt?: number; loadError?: string | null; bumpCount?: boolean },
): void {
  void client.update((root) => {
    const cur = root.plugin.kernel.viewState[viewId];
    if (!cur) return;
    const next = { ...cur };
    if ("loadedAt" in patch) next.loadedAt = patch.loadedAt ?? null;
    if ("loadError" in patch) next.loadError = patch.loadError ?? null;
    if (patch.bumpCount) next.loadCount = (cur.loadCount ?? 0) + 1;
    root.plugin.kernel.viewState = {
      ...root.plugin.kernel.viewState,
      [viewId]: next,
    };
  });
}

// ---------------------------------------------------------------------------
// ViewProvider: child-iframe boot harness.
//
// Every iframe's top-level App.tsx wraps its UI in <ViewProvider> instead of
// the previous five-deep RpcProvider/EventsProvider/KyjuClientProvider/
// KyjuProvider stack + WS-connection branching. Inside the subtree:
//
//   - useRpc / useEvents / useKyjuClient / useDb all work.
//   - useViewProps() returns the view's props bag (Record<string, string>).
//
// Iframes whose URL has no `?viewId=` (e.g. the orchestrator host) skip the
// useViewProps context; calling useViewProps() in that subtree throws.
// ---------------------------------------------------------------------------

const NO_VIEW_PROPS = Symbol("no-view-props");
type ViewPropsValue = Record<string, string> | typeof NO_VIEW_PROPS;
const ViewPropsContext = createContext<ViewPropsValue>(NO_VIEW_PROPS);

export function useViewProps(): Record<string, string> {
  const ctx = useContext(ViewPropsContext);
  if (ctx === NO_VIEW_PROPS) {
    throw new Error(
      "useViewProps() must be used inside ViewProvider, in an iframe whose URL has ?viewId=",
    );
  }
  return ctx;
}

export type ViewProviderProps = {
  fallback?: ReactNode;
  errorFallback?: (error: string) => ReactNode;
  children: ReactNode;
};

export function ViewProvider({
  fallback,
  errorFallback,
  children,
}: ViewProviderProps): ReactElement {
  const connection = useWsConnection();

  if (connection.status === "connecting") {
    return <>{fallback ?? null}</>;
  }
  if (connection.status === "error") {
    if (errorFallback) return <>{errorFallback(connection.error)}</>;
    return (
      <div className="flex h-full items-center justify-center text-red-400 text-sm">
        {connection.error}
      </div>
    );
  }

  return (
    <ConnectedViewProvider
      connection={connection}
      fallback={fallback}
    >
      {children}
    </ConnectedViewProvider>
  );
}

function ConnectedViewProvider({
  connection,
  fallback,
  children,
}: {
  connection: Extract<WsConnectionState, { status: "connected" }>;
  fallback: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <RpcProvider value={connection.rpc}>
      <EventsProvider value={connection.events}>
        <KyjuClientProvider value={connection.kyjuClient}>
          <KyjuProvider
            client={connection.kyjuClient}
            replica={connection.replica}
          >
            <ViewPropsResolver fallback={fallback}>
              {children}
            </ViewPropsResolver>
          </KyjuProvider>
        </KyjuClientProvider>
      </EventsProvider>
    </RpcProvider>
  );
}

function ViewPropsResolver({
  fallback,
  children,
}: {
  fallback: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  const viewId = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("viewId") ?? null;
  }, []);

  // URL-derived initial props. We expose the full query bag (including
  // the env-shaped keys like `windowId`, `workspaceId`, `viewId`) — they
  // arrived as parent-passed values and the child has every right to
  // read them. `wsPort`/`wsToken` come along for the ride; children
  // that don't care can ignore them.
  const urlProps = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    for (const [k, v] of p) out[k] = v;
    return out;
  }, []);

  // Iframes with no viewId (e.g. orchestrator host) don't get the props
  // context. useViewProps() will throw if called from within them.
  if (!viewId) {
    return <>{children}</>;
  }

  return (
    <KyjuRowPropsBridge
      viewId={viewId}
      urlProps={urlProps}
      fallback={fallback}
    >
      {children}
    </KyjuRowPropsBridge>
  );
}

function KyjuRowPropsBridge({
  viewId,
  urlProps,
  children,
}: {
  viewId: string;
  urlProps: Record<string, string>;
  fallback: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  // Resolution rule: start with the URL bag (which always includes the
  // platform-set keys: wsPort/wsToken/windowId/workspaceId/viewId, plus
  // every prop the parent serialized at mount time). Overlay the kyju
  // row's `props` on top — that's the reactive surface for persisted
  // views. Ephemeral views (no row) just see the URL bag.
  //
  // Why overlay instead of replace: the row stores only the caller's
  // `props` argument; it doesn't carry the inherited env keys, so a
  // pure replace would strip windowId/wsPort/etc from the bag once
  // the row arrives.
  const rowProps = useDb((root) => {
    return (
      root.plugin.kernel.views.find((v) => v.id === viewId)?.props ?? null
    );
  });
  const resolved = useMemo(
    () => ({ ...urlProps, ...(rowProps ?? {}) }),
    [urlProps, rowProps],
  );
  return (
    <ViewPropsContext.Provider value={resolved}>
      {children}
    </ViewPropsContext.Provider>
  );
}
