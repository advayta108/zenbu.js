import { useDragRegion } from "#zenbu/init/src/renderer/lib/drag-region"

// Invisible drag strip that keeps the macOS chat-title-bar drag UX without
// rendering a label. The plugins view sits inside the workspace shell
// iframe, which doesn't otherwise expose a draggable region.
export function TitleBar() {
  const dragRef = useDragRegion<HTMLDivElement>()
  return <div ref={dragRef} className="shrink-0" style={{ height: 18 }} />
}
