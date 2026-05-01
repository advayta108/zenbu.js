// Sidebar-open toggle button. Used at two positions inside the workspace
// view:
//   1. Inside the agent sidebar header (when sidebarOpen === true)
//   2. Floating on the left edge of the chat area (when sidebarOpen === false)
//
// All writes go to plugin["agent-manager"].workspaceShellState[shellViewId]
// from the parent component — the orchestrator no longer reads or writes
// this field, by design.
export function SidebarToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? "Hide sidebar" : "Show sidebar"}
      className={
        "inline-flex items-center justify-center rounded text-neutral-500 cursor-pointer hover:bg-black/10 hover:text-neutral-700 transition-colors " +
        (className ?? "")
      }
      style={{ width: 22, height: 22 }}
    >
      <SidebarToggleIcon open={open} />
    </button>
  )
}

function SidebarToggleIcon(_: { open: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  )
}
