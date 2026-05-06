import { useDb } from "#zenbu/init/src/renderer/lib/kyju-react"
import { useRpc } from "#zenbu/init/src/renderer/lib/providers"
import type { DevtoolsAgent } from "../../../../shared/schema"

export function AgentSidebar({
  agents,
  activeAgentId,
  onSelect,
}: {
  agents: DevtoolsAgent[]
  activeAgentId: string | null
  onSelect: (agentId: string) => void
}) {
  const rpc = useRpc()
  const kernelAgents = useDb((root) => root.plugin.kernel.agents) as Array<{
    id: string
    title?: { kind: string; value?: string }
  }>

  const titleFor = (id: string) => {
    const a = kernelAgents.find((x) => x.id === id)
    if (!a) return id.slice(0, 8)
    if (a.title?.kind === "set" && a.title.value) return a.title.value
    return id.slice(0, 8)
  }

  return (
    <aside
      style={{
        width: 220,
        background: "var(--zenbu-panel-bg, #0a0a0a)",
        borderLeft: "1px solid var(--zenbu-panel-border, #1a1a1a)",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--muted-foreground, #777)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        Agents
        <button
          onClick={() => (rpc as any).devtools.createAgent()}
          style={{
            border: 0,
            background: "transparent",
            cursor: "pointer",
            color: "var(--muted-foreground, #777)",
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
          title="New agent"
        >
          +
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 6px 6px" }}>
        {agents.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--muted-foreground, #777)" }}>
            No agents yet
          </div>
        )}
        {agents.map((a) => {
          const active = a.agentId === activeAgentId
          return (
            <button
              key={a.agentId}
              onClick={() => onSelect(a.agentId)}
              style={{
                display: "block",
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 6,
                border: 0,
                background: active
                  ? "var(--zenbu-accent, rgba(255,255,255,0.08))"
                  : "transparent",
                color: "var(--foreground, #e5e5e5)",
                fontSize: 13,
                cursor: "pointer",
                marginBottom: 2,
                font: "inherit",
              }}
            >
              {titleFor(a.agentId)}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
