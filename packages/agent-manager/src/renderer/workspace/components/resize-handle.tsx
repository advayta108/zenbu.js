import { useCallback } from "react"

// 4-pixel column-resize handle. `direction` controls whether the drag
// grows the panel to the left or right of the handle.
export function ResizeHandle({
  onResizeChange,
  direction,
  store,
}: {
  onResizeChange: (resizing: boolean) => void
  direction: "left" | "right"
  store: { get: () => number; set: (v: number) => void }
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = store.get()
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      onResizeChange(true)

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        store.set(
          direction === "right" ? startWidth + delta : startWidth - delta,
        )
      }
      const onUp = () => {
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        onResizeChange(false)
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [onResizeChange, store, direction],
  )

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 4,
        cursor: "col-resize",
        flexShrink: 0,
        background: "transparent",
        marginLeft: -2,
        marginRight: -2,
        zIndex: 1,
      }}
    />
  )
}
