import { useCallback, useEffect, useState } from "react";
import {
  RpcProvider,
  EventsProvider,
  KyjuClientProvider,
  useRpc,
  useKyjuClient,
  useWsConnection,
} from "@/lib/ws-connection";
import { KyjuProvider, useDb } from "@/lib/kyju-react";
import type { WsConnectionState } from "@/lib/ws-connection";
import { Composer } from "@/views/chat/components/Composer";
import { FolderSyncIcon } from "lucide-react";

const urlParams = new URLSearchParams(window.location.search);
const windowId = urlParams.get("windowId") ?? "";
// `viewId` is the (sentinel) view id of this new-agent slot. The
// promote-flow uses it to find and replace the sentinel with the real
// chat view.
const sentinelViewId = urlParams.get("viewId") ?? "";

function NewAgentScreen() {
  const rpc = useRpc();
  const client = useKyjuClient();

  // Active workspace's first cwd is the default location for the new agent.
  // The user can override it via the cwd picker before submitting.
  const activeWorkspaceId = useDb(
    (root) => root.plugin.kernel.windowState[windowId]?.activeWorkspaceId ?? null,
  );
  const workspaces = useDb((root) => root.plugin.kernel.workspaces);
  const activeWorkspace = (workspaces ?? []).find(
    (w) => w.id === activeWorkspaceId,
  );
  const workspaceCwd = activeWorkspace?.cwds?.[0];

  // The new-chat view mounts around the head of the warm pool: a real,
  // already-spawned agent row whose model/mode/thinking selectors and
  // draft state all live on the agent itself. On submit, `promoteNewAgentTab`
  // pops this same head and swaps the sentinel view for a real chat view,
  // so the agent flows directly into the chat view with no swap mid-flight.
  const poolAgentId = useDb(
    (root) => root.plugin.kernel.pool?.[0]?.agentId,
  );

  // Latch the warm agent id at submit time so the iframe doesn't flash
  // an "invariant violated" banner during the swap (the pool head pops
  // before the orchestrator commits the iframe-src change).
  const [latchedAgentId, setLatchedAgentId] = useState<string | null>(null);
  const warmAgentId = latchedAgentId ?? poolAgentId;

  const [pendingCwd, setPendingCwd] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (pendingCwd === undefined && workspaceCwd) setPendingCwd(workspaceCwd);
  }, [workspaceCwd, pendingCwd]);

  const displayCwd = pendingCwd ?? workspaceCwd ?? "~";

  const onPickCwd = useCallback(async () => {
    const dir: string | null = await rpc.window.pickDirectory();
    if (!dir) return;
    setPendingCwd(dir);
  }, [rpc]);

  const onSubmit = useCallback(
    async (text: string, images: any[], editorStateJson: unknown) => {
      const cwd = pendingCwd ?? workspaceCwd;
      // Latch the current pool head so subsequent renders against an empty
      // pool don't flash the banner during the swap.
      if (poolAgentId) setLatchedAgentId(poolAgentId);

      // Promote the sentinel view to a real chat view: kernel creates the
      // chat view referencing the warm agent and updates activeViewId.
      // Returns `{ agentId, viewId }`.
      const { agentId } = await rpc["new-agent"].promoteNewAgentTab({
        windowId,
        sentinelViewId,
        cwd,
        workspaceId: activeWorkspaceId ?? undefined,
      });

      // Write the user_prompt to the agent's event log immediately so chat
      // displays the message without waiting for the agent's first ACP roundtrip.
      const agentNodeId = client.plugin.kernel.agents
        .read()
        .findIndex((a) => a.id === agentId);
      const node =
        agentNodeId !== -1 ? client.plugin.kernel.agents[agentNodeId] : null;

      const now = Date.now();
      const eventData: any = {
        kind: "user_prompt",
        text,
        editorState: editorStateJson,
      };
      if (images.length > 0) {
        eventData.images = images.map((img: any) => ({
          blobId: img.blobId,
          mimeType: img.mimeType,
        }));
      }
      if (node) {
        await node.eventLog.concat([{ timestamp: now, data: eventData }]);
        await node.status.set("streaming");
        await node.lastUserMessageAt?.set(now);
      }

      await rpc.agent.send(
        agentId,
        text,
        images.length > 0 ? images : undefined,
        cwd ? { cwd } : undefined,
      );
    },
    [rpc, client, pendingCwd, workspaceCwd, poolAgentId, activeWorkspaceId],
  );

  if (!warmAgentId) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <div className="max-w-md rounded border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          invariant violated: warm pool is empty. PooledAgentService should
          always keep `kernel.pool.length === poolSize`; if you see this,
          the refill loop is broken.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-start justify-center px-6 pt-[14vh]">
      <div className="w-full max-w-[919px] flex flex-col">
        <div className="mx-auto w-full max-w-[919px] px-4 mb-1">
          <button
            type="button"
            onClick={onPickCwd}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-neutral-600 hover:bg-black/5 hover:text-neutral-900 transition-colors"
            title={displayCwd}
          >
            <span className="truncate max-w-[360px]">
              {displayCwd.split("/").pop() || displayCwd}
            </span>
            <FolderSyncIcon className="size-3 opacity-70" />
          </button>
        </div>
        <Composer
          agentId={warmAgentId}
          viewId={sentinelViewId}
          onSubmit={onSubmit}
        />
      </div>
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
            <NewAgentScreen />
          </KyjuProvider>
        </KyjuClientProvider>
      </EventsProvider>
    </RpcProvider>
  );
}

export function App() {
  const connection = useWsConnection();
  if (connection.status === "connecting") {
    return <div className="h-full" />;
  }
  if (connection.status === "error") {
    return (
      <div className="flex h-full items-center justify-center text-red-500 text-xs">
        {connection.error}
      </div>
    );
  }
  return <ConnectedApp connection={connection} />;
}
