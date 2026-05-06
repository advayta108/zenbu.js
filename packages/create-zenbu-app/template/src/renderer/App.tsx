import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"
import { useRpc } from "#zenbu/init/src/renderer/lib/providers"

function Titlebar() {
  const rpc = useRpc()
  return (
    <div
      style={{
        height: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 12px 0 72px",
        // @ts-expect-error webkit property
        WebkitAppRegion: "drag",
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => (rpc as any).devtools.togglePanel()}
        style={{
          // @ts-expect-error webkit property
          WebkitAppRegion: "no-drag",
          width: 28,
          height: 28,
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.1)",
          background: "transparent",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          color: "var(--muted-foreground, #888)",
          padding: 0,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>
  )
}

function Home() {
  return (
    <main style={{
      flex: 1,
      padding: "0 32px 32px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "var(--foreground, #e5e5e5)",
    }}>
      <h1>Welcome to Zenbu</h1>
      <p style={{ color: "var(--muted-foreground, #999)", marginTop: 8 }}>
        Edit <code>src/renderer/App.tsx</code> to get started.
      </p>
    </main>
  )
}

export function App() {
  return (
    <ViewProvider fallback={<div style={{ height: "100vh" }} />}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <Titlebar />
        <Home />
      </div>
    </ViewProvider>
  )
}
