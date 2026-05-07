import { ViewProvider, useViewProps } from "../../lib/View"
import { ComposerPanel } from "../chat/ComposerPanel"

const viewId = new URLSearchParams(window.location.search).get("viewId") ?? ""

function MessageInputContent() {
  const props = useViewProps()
  const agentId = props.agentId ?? ""
  if (!agentId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-400 text-sm">
        <p>No agent ID specified</p>
        <p className="text-xs text-neutral-300">
          The view's <code className="bg-neutral-100 px-1 rounded">props.agentId</code> is missing.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex-1" />
      <ComposerPanel agentId={agentId} viewId={viewId} />
    </div>
  )
}

export function App() {
  return (
    <ViewProvider
      fallback={
        <div className="flex h-full items-center justify-center text-neutral-400 text-sm" />
      }
    >
      <MessageInputContent />
    </ViewProvider>
  )
}
