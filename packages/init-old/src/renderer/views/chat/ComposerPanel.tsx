import { Composer } from "./components/Composer"
import { ComposerToolbar } from "./components/ComposerToolbar"
import { QueuedMessages } from "./components/QueuedMessages"
import type { ExpectedVisibleMessage } from "./lib/chat-invariants"

export type ComposerPanelProps = {
  agentId: string
  viewId: string
  scrollToBottom?: () => void
  debugExpectedVisibleMessageRef?: React.MutableRefObject<ExpectedVisibleMessage | null>
}

export function ComposerPanel({
  agentId,
  viewId,
  scrollToBottom,
  debugExpectedVisibleMessageRef,
}: ComposerPanelProps) {
  return (
    <div className="shrink-0">
      <QueuedMessages agentId={agentId} />
      <Composer
        agentId={agentId}
        viewId={viewId}
        scrollToBottom={scrollToBottom}
        debugExpectedVisibleMessageRef={debugExpectedVisibleMessageRef}
      />
      <ComposerToolbar agentId={agentId} viewId={viewId} />
    </div>
  )
}
