import { Composer } from "./components/Composer"
import type { ExpectedVisibleMessage } from "./lib/chat-invariants"

export type ComposerPanelProps = {
  agentId: string
  scrollToBottom?: () => void
  debugExpectedVisibleMessageRef?: React.MutableRefObject<ExpectedVisibleMessage | null>
}

export function ComposerPanel({
  agentId,
  scrollToBottom,
  debugExpectedVisibleMessageRef,
}: ComposerPanelProps) {
  return (
    <div className="shrink-0">
      <Composer
        agentId={agentId}
        scrollToBottom={scrollToBottom}
        debugExpectedVisibleMessageRef={debugExpectedVisibleMessageRef}
      />
    </div>
  )
}
