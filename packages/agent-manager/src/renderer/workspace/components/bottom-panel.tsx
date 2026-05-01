import { View } from "#zenbu/init/src/renderer/lib/View"
import { formatScope } from "../lib/format-scope"
import type { RegistryEntry } from "./utility-rail"

// Resizable bottom strip that can mount any registered `meta.bottomPanel`
// view in a tab strip. State (open/selected/height) is stored on the
// per-workspace `workspaceState` record, not the per-view-id record.
export function BottomPanel({
  entries,
  selectedScope,
  height,
  windowId,
  onSelectScope,
  onClose,
}: {
  entries: RegistryEntry[]
  selectedScope: string | null
  height: number
  windowId: string
  onSelectScope: (scope: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        height,
        background: "var(--zenbu-panel)",
        borderTop: "1px solid var(--zenbu-panel-border)",
      }}
    >
      <div
        className="shrink-0 flex items-center gap-1 px-2"
        style={{
          height: 28,
          borderBottom: "1px solid var(--zenbu-panel-border)",
          background: "var(--zenbu-panel)",
        }}
      >
        {entries.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1">
            no bottom-panel views
          </div>
        ) : (
          entries.map((e) => {
            const label = e.meta?.label ?? formatScope(e.scope)
            return (
              <button
                key={e.scope}
                type="button"
                onClick={() => onSelectScope(e.scope)}
                className={`bp-tab inline-flex items-center gap-1 px-2 h-[22px] rounded text-[11px] cursor-pointer ${
                  e.scope === selectedScope ? "is-active" : ""
                }`}
                title={label}
              >
                {e.icon && (
                  <span
                    className="inline-flex items-center justify-center"
                    dangerouslySetInnerHTML={{ __html: e.icon }}
                  />
                )}
                <span>{label}</span>
              </button>
            )
          })
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          title="Close (Cmd+J)"
          className="bp-close inline-flex items-center justify-center rounded cursor-pointer"
          style={{ width: 22, height: 22 }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {selectedScope && (
          <View
            id={`bottom-panel:${windowId}:${selectedScope}`}
            scope={selectedScope}
            pinned
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }}
          />
        )}
      </div>
      <style>{`
        .bp-tab { color: var(--muted-foreground); transition: background-color 80ms ease; }
        .bp-tab:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
        .bp-tab.is-active { background: var(--accent); color: var(--accent-foreground); }
        .bp-tab svg { width: 12px; height: 12px; opacity: 0.85; }
        .bp-close { color: var(--muted-foreground); transition: background-color 80ms ease; }
        .bp-close:hover { background: var(--zenbu-control-hover); color: var(--foreground); }
      `}</style>
    </div>
  )
}
