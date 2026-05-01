// Full-viewport invisible overlay shown during a resize drag. Captures
// mouse events at z-index 9999 so iframes underneath don't steal them
// when the cursor crosses the iframe boundary mid-drag.
export function ResizeOverlay({
  direction = "col",
}: {
  direction?: "col" | "row"
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        cursor: direction === "row" ? "row-resize" : "col-resize",
        background: "transparent",
      }}
    />
  )
}
