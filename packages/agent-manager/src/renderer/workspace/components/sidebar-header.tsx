import type { ReactNode } from "react"
import { SidebarToggle } from "./sidebar-toggle"

// Compact row that sits at the top of the agent sidebar (above the
// "New Chat" / "Plugins" rows). Holds the sidebar-collapse toggle on the
// left and a free `right` slot on the right (where the workspace view
// drops the agent search picker).
export function SidebarHeader({
  onToggleSidebar,
  right,
}: {
  onToggleSidebar: () => void
  right?: ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between gap-1 px-1 py-1"
      style={{ height: 30 }}
    >
      <SidebarToggle open onToggle={onToggleSidebar} />
      <div className="flex items-center gap-0.5">{right}</div>
    </div>
  )
}
