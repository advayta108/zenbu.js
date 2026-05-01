import { useCallback, useEffect, useState } from "react"
import { FolderSyncIcon } from "lucide-react"
import {
  useRpc,
  useKyjuClient,
} from "#zenbu/init/src/renderer/lib/ws-connection"
import { useDb } from "#zenbu/init/src/renderer/lib/kyju-react"
import { Composer } from "#zenbu/init/src/renderer/views/chat/components/Composer"

const urlParams = new URLSearchParams(window.location.search)
const windowId = urlParams.get("windowId") ?? ""
// `viewId` is the (sentinel) view id of this new-agent slot. The
// promote-flow uses it to find and replace the sentinel with the real
// chat view.
const sentinelViewId = urlParams.get("viewId") ?? ""

export function NewAgentScreen() {
  const rpc = useRpc()
  const client = useKyjuClient()

  // Active workspace's first cwd is the default location for the new agent.
  // The user can override it via the cwd picker before submitting.
  const activeWorkspaceId = useDb(
    (root) =>
      root.plugin.kernel.windowState[windowId]?.activeWorkspaceId ?? null,
  )
  const workspaces = useDb((root) => root.plugin.kernel.workspaces)
  const activeWorkspace = (workspaces ?? []).find(
    (w) => w.id === activeWorkspaceId,
  )
  const workspaceCwd = activeWorkspace?.cwds?.[0]

  // Pool lives on agent-manager now.
  const poolAgentId = useDb(
    (root) => root.plugin["agent-manager"].pool?.[0]?.agentId,
  )

  const [latchedAgentId, setLatchedAgentId] = useState<string | null>(null)
  const warmAgentId = latchedAgentId ?? poolAgentId

  const [pendingCwd, setPendingCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (pendingCwd === undefined && workspaceCwd) setPendingCwd(workspaceCwd)
  }, [workspaceCwd, pendingCwd])

  const displayCwd = pendingCwd ?? workspaceCwd ?? "~"

  const onPickCwd = useCallback(async () => {
    const dir: string | null = await rpc.window.pickDirectory()
    if (!dir) return
    setPendingCwd(dir)
  }, [rpc])

  const onSubmit = useCallback(
    async (text: string, images: any[], editorStateJson: unknown) => {
      const cwd = pendingCwd ?? workspaceCwd
      if (poolAgentId) setLatchedAgentId(poolAgentId)

      const { agentId } = await rpc["new-agent"].promoteNewAgentTab({
        windowId,
        sentinelViewId,
        cwd,
        workspaceId: activeWorkspaceId ?? undefined,
      })

      const agentNodeId = client.plugin.kernel.agents
        .read()
        .findIndex((a) => a.id === agentId)
      const node =
        agentNodeId !== -1 ? client.plugin.kernel.agents[agentNodeId] : null

      const now = Date.now()
      const eventData: any = {
        kind: "user_prompt",
        text,
        editorState: editorStateJson,
      }
      if (images.length > 0) {
        eventData.images = images.map((img: any) => ({
          blobId: img.blobId,
          mimeType: img.mimeType,
        }))
      }
      if (node) {
        await node.eventLog.concat([{ timestamp: now, data: eventData }])
        await node.status.set("streaming")
        await node.lastUserMessageAt?.set(now)
      }

      await rpc.agent.send(
        agentId,
        text,
        images.length > 0 ? images : undefined,
        cwd ? { cwd } : undefined,
      )
    },
    [rpc, client, pendingCwd, workspaceCwd, poolAgentId, activeWorkspaceId],
  )

  if (!warmAgentId) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <div className="max-w-md rounded border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          invariant violated: warm pool is empty. PooledAgentService should
          always keep `plugin["agent-manager"].pool.length === poolSize`; if
          you see this, the refill loop is broken.
        </div>
      </div>
    )
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
  )
}
