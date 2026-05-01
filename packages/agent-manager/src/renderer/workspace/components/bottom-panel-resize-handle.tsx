import { useCallback } from "react"

// 4-pixel row-resize handle for the bottom panel. Reports a preview
// height during drag (so the panel resizes live without writing through
// to kyju on every pixel) and a single commit on mouseup.
export function BottomPanelResizeHandle({
  getStartHeight,
  onPreview,
  onCommit,
  onResizeChange,
}: {
  getStartHeight: () => number
  onPreview: (next: number) => void
  onCommit: () => void
  onResizeChange: (resizing: boolean) => void
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startHeight = getStartHeight()
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
      onResizeChange(true)

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY
        // Drag up shrinks delta (negative) → bigger panel; clamp.
        const next = Math.max(120, Math.min(800, startHeight - delta))
        onPreview(next)
      }
      const onUp = () => {
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        onResizeChange(false)
        onCommit()
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [getStartHeight, onPreview, onCommit, onResizeChange],
  )

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        height: 4,
        cursor: "row-resize",
        flexShrink: 0,
        background: "transparent",
        marginTop: -2,
        marginBottom: -2,
        zIndex: 1,
      }}
    />
  )
}
