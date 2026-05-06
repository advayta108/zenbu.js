import { useEffect } from "react"
import { View } from "#zenbu/init/src/renderer/lib/View"
import { useDb } from "#zenbu/init/src/renderer/lib/kyju-react"
import { useRpc } from "#zenbu/init/src/renderer/lib/providers"
import { AgentSidebar } from "./components/AgentSidebar"
import { Titlebar } from "./components/Titlebar"
import { viewId } from "./lib/view-id"

export function ShellApp() {
  const rpc = useRpc()
  const state = useDb((root) => root.plugin.devtools.viewState[viewId])
  const agents = useDb((root) => root.plugin.devtools.agents)

  const activeAgentId = state?.activeAgentId ?? agents[0]?.agentId ?? null
  const sidebarOpen = state?.sidebarOpen ?? false

  // Ensure we have a state row and a sensible default activeAgentId.
  useEffect(() => {
    if (!state && agents.length > 0) {
      ;(rpc as any).devtools.selectAgent(viewId, agents[0].agentId)
    }
  }, [state, agents, rpc])

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--zenbu-panel)" }}>
      <Titlebar onToggleSidebar={() => (rpc as any).devtools.toggleSidebar(viewId)} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {activeAgentId ? (
            <View
              id={`devtools-chat-${activeAgentId}`}
              scope="devtools-chat"
              props={{ agentId: activeAgentId }}
              persisted
              pinned
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            />
          ) : (
            <div style={{
              display: "grid",
              placeItems: "center",
              height: "100%",
              color: "var(--muted-foreground)",
              fontSize: 13,
            }}>
              No agent selected
            </div>
          )}
        </main>
        {sidebarOpen && (
          <AgentSidebar
            agents={agents}
            activeAgentId={activeAgentId}
            onSelect={(id) => (rpc as any).devtools.selectAgent(viewId, id)}
          />
        )}
      </div>
    </div>
  )
}
