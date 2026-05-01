import { formatScope } from "../lib/format-scope"

export type RegistryEntry = {
  scope: string
  url: string
  port: number
  icon?: string
  workspaceId?: string
  meta?: {
    kind?: string
    sidebar?: boolean
    bottomPanel?: boolean
    label?: string
  }
}

// Vertical rail on the right edge of the workspace shell that lists every
// `meta.sidebar` view as a clickable icon. Clicking toggles which utility
// view (if any) is mounted in the slot to the left of the rail.
export function UtilityRail({
  entries,
  selected,
  panelVisible,
  onIconClick,
}: {
  entries: RegistryEntry[]
  selected: string
  panelVisible: boolean
  onIconClick: (scope: string) => void
}) {
  const RAIL_WIDTH = 44
  return (
    <div
      className="shrink-0 flex flex-col items-center gap-1 py-2"
      style={{
        width: RAIL_WIDTH,
        background: "var(--zenbu-panel)",
        borderLeft: panelVisible ? "none" : "1px solid var(--zenbu-panel-border)",
      }}
    >
      {entries.length === 0 && (
        <div
          className="text-[10px] text-muted-foreground px-1 text-center mt-2"
          title="No sidebar views registered"
        >
          no views
        </div>
      )}
      {entries.map((e) => (
        <button
          key={e.scope}
          type="button"
          onClick={() => onIconClick(e.scope)}
          title={formatScope(e.scope)}
          className={`usb-icon relative inline-flex items-center justify-center rounded text-muted-foreground cursor-pointer ${
            e.scope === selected ? "is-active" : ""
          }`}
          style={{ width: 36, height: 36 }}
        >
          {e.icon ? (
            <span
              className="inline-flex items-center justify-center"
              dangerouslySetInnerHTML={{ __html: e.icon }}
            />
          ) : (
            <span
              className="inline-flex items-center justify-center rounded"
              style={{
                width: 18,
                height: 18,
                fontSize: 11,
                fontWeight: 600,
                background: "var(--zenbu-control-hover)",
              }}
            >
              {(e.scope[0] ?? "?").toUpperCase()}
            </span>
          )}
        </button>
      ))}
      <style>{`
        .usb-icon { transition: background-color 80ms ease; }
        .usb-icon:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
        .usb-icon.is-active { background: var(--accent); color: var(--accent-foreground); }
        .usb-icon svg { width: 20px; height: 20px; filter: grayscale(100%); opacity: 0.65; transition: opacity 80ms ease; }
        .usb-icon:hover svg { opacity: 0.85; }
        .usb-icon.is-active svg { opacity: 1; }
      `}</style>
    </div>
  )
}
