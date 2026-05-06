export function Titlebar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  return (
    <div
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 8px",
        background: "var(--zenbu-panel)",
        flexShrink: 0,
      }}
    >
      <button
        onClick={onToggleSidebar}
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          border: 0,
          background: "transparent",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          color: "var(--muted-foreground)",
          padding: 0,
        }}
        title="Toggle agents"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    </div>
  )
}
