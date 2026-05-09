/**
 * Public renderer-side surface for plugin authors. Wraps the websocket
 * lifecycle, RPC client, replica DB connection, and event subscription
 * behind a single `<ZenbuProvider>` plus hooks.
 *
 * DB hooks (`useDb`, `useCollection`) are implemented in `@zenbu/kyju/react`
 * and composed here via `KyjuProvider` mounted inside `ZenbuProvider`.
 * Core only adds the websocket lifecycle (RPC/events) and the
 * `ZenbuRegister`-driven type narrowing so call sites never need a generic.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectReplica,
  dbStringify,
  dbParse,
} from "@zenbu/kyju/transport";
import type {
  ClientProxy,
  SchemaShape,
} from "@zenbu/kyju";
import { createKyjuReact } from "@zenbu/kyju/react";
import type {
  CollectionRefValue,
} from "@zenbu/kyju/schema";
import { connectRpc } from "@zenbu/zenrpc";
import type {
  EventProxy,
  RouterProxy,
} from "@zenbu/zenrpc";
import type {
  ResolvedDbRoot,
  ResolvedServiceRouter,
  ResolvedEvents,
} from "./registry";

type AnyRpc = RouterProxy<Record<string, Record<string, (...args: any[]) => any>>>;
type AnyEvents = EventProxy<Record<string, unknown>>;
type AnyDbClient = ClientProxy<SchemaShape>;
type Replica = Awaited<ReturnType<typeof connectReplica>>["replica"];

type Connection = {
  rpc: AnyRpc;
  events: AnyEvents;
  db: AnyDbClient;
  replica: Replica;
};

type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; conn: Connection }
  | { status: "error"; error: string };

const ConnectionContext = createContext<ConnectionState | null>(null);

// The `Resolved*` types are conditional on `ZenbuRegister` — they resolve
// lazily at the consumer's compilation unit (after `zen link`'s module
// augmentation is in scope). We alias them here so core's own build
// doesn't eagerly collapse them to the fallback.
type RegisteredDbRoot = ResolvedDbRoot;
type RegisteredServiceRouter = ResolvedServiceRouter;
type RegisteredEvents = ResolvedEvents;

const kyjuReact = createKyjuReact<SchemaShape, RegisteredDbRoot>();

// ---- DB hooks (delegated to kyju, typed via ZenbuRegister) ----

/**
 * Subscribe to a slice of the live DB. The selector's `root` is typed via
 * `ZenbuRegister["db"]`, populated by `zen link`. No generic at the call site.
 *
 *   const count = useDb((root) => root.plugin.app.count)
 */
export function useDb(): RegisteredDbRoot;
export function useDb<T>(
  selector: (root: RegisteredDbRoot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useDb<T>(
  selector?: (root: RegisteredDbRoot) => T,
  isEqual?: (a: T, b: T) => boolean,
) {
  return kyjuReact.useDb(selector as any, isEqual);
}

export const useCollection = kyjuReact.useCollection;

// ---- Provider ----

export type ZenbuProviderProps = {
  wsUrl?: string;
  fallback?: ReactNode;
  errorFallback?: (error: string) => ReactNode;
  children: ReactNode;
};

export function ZenbuProvider({
  wsUrl,
  fallback,
  errorFallback,
  children,
}: ZenbuProviderProps) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const cleanupRef = useRef<(() => void) | null>(null);
  const retriesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const resolvedUrl = (() => {
      if (wsUrl) return wsUrl;
      const params = new URLSearchParams(window.location.search);
      const port = params.get("wsPort");
      const token = params.get("wsToken");
      if (!port) return { error: "Missing ?wsPort= in URL" } as const;
      if (!token) return { error: "Missing ?wsToken= in URL" } as const;
      return `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`;
    })();

    if (typeof resolvedUrl !== "string") {
      setState({ status: "error", error: resolvedUrl.error });
      return;
    }

    function connect() {
      if (cancelled) return;
      setState({ status: "connecting" });
      cleanupRef.current = null;

      const ws = new WebSocket(resolvedUrl as string);

      ws.onopen = async () => {
        try {
          retriesRef.current = 0;

          const {
            server: rpc,
            events,
            disconnect: disconnectRpc,
          } = await connectRpc({
            version: "0",
            send: (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ch: "rpc", data }));
              }
            },
            subscribe: (cb) => {
              const handler = (e: MessageEvent) => {
                const msg = JSON.parse(e.data);
                if (msg.ch === "rpc") cb(msg.data);
              };
              ws.addEventListener("message", handler);
              return () => ws.removeEventListener("message", handler);
            },
          });

          const {
            client: db,
            replica,
            disconnect: disconnectDb,
          } = await connectReplica({
            send: (event) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(dbStringify({ ch: "db", data: event }));
              }
            },
            subscribe: (cb) => {
              const handler = (e: MessageEvent) => {
                const msg = dbParse(e.data);
                if (msg.ch === "db") cb(msg.data);
              };
              ws.addEventListener("message", handler);
              return () => ws.removeEventListener("message", handler);
            },
          });

          if (cancelled) {
            await disconnectDb();
            disconnectRpc();
            ws.close();
            return;
          }

          const viewMatch = window.location.pathname.match(/^\/views\/([^/]+)\//);
          const viewScope = viewMatch ? viewMatch[1] : null;
          let unsubReload: (() => void) | null = null;
          if (viewScope) {
            const adviceReload = (events as any)?.advice?.reload;
            if (adviceReload?.subscribe) {
              unsubReload = adviceReload.subscribe((data: { scope?: string }) => {
                if (data?.scope === viewScope) location.reload();
              });
            }
          }

          cleanupRef.current = () => {
            unsubReload?.();
            disconnectDb();
            disconnectRpc();
            ws.close();
          };

          setState({
            status: "connected",
            conn: {
              rpc: rpc as AnyRpc,
              events: events as AnyEvents,
              db: db as AnyDbClient,
              replica,
            },
          });
        } catch (err) {
          if (!cancelled) {
            ws.close();
            scheduleReconnect();
          }
        }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (!cancelled) {
          cleanupRef.current?.();
          cleanupRef.current = null;
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = Math.min(300 * Math.pow(2, retriesRef.current), 3000);
      retriesRef.current++;
      setState({ status: "connecting" });
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [wsUrl]);

  if (state.status === "connecting") {
    return createElement(
      "span",
      { "data-zenbu-connecting": true },
      fallback ?? null,
    );
  }
  if (state.status === "error") {
    return createElement(
      "span",
      { "data-zenbu-error": true },
      errorFallback ? errorFallback(state.error) : null,
    );
  }

  // Compose KyjuProvider inside ConnectionContext so kyju's useDb /
  // useCollection hooks find their context. The KyjuProvider receives
  // the same replica + client that core stores on ConnectionContext.
  return createElement(
    ConnectionContext.Provider,
    { value: state },
    createElement(
      kyjuReact.KyjuProvider,
      { client: state.conn.db, replica: state.conn.replica, children },
    ),
  );
}

// ---- Connection accessor (RPC/events/db-client) ----

function useConnection(): Connection {
  const state = useContext(ConnectionContext);
  if (!state) {
    throw new Error("useDb/useRpc/useEvents must be used inside <ZenbuProvider>");
  }
  if (state.status !== "connected") {
    throw new Error(
      `Zenbu connection is not ready (status: ${state.status}). ` +
        `Render a <ZenbuProvider fallback={...}> around your hooks.`,
    );
  }
  return state.conn;
}

// ---- RPC / events / db-client hooks (core-only, not DB subscription) ----

export type { ZenbuRegister } from "./registry";

export function useRpc(): RouterProxy<RegisteredServiceRouter> {
  return useConnection().rpc as unknown as RouterProxy<RegisteredServiceRouter>;
}

export type DbClient = {
  readRoot(): RegisteredDbRoot;
  update(
    fn: (root: RegisteredDbRoot) => void | RegisteredDbRoot,
  ): Promise<void>;
  createBlob(data: Uint8Array, hot?: boolean): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
};

export function useDbClient(): DbClient {
  return useConnection().db as unknown as DbClient;
}

export function useEvents(): EventProxy<RegisteredEvents> {
  return useConnection().events as unknown as EventProxy<RegisteredEvents>;
}

export type { CollectionRefValue };
