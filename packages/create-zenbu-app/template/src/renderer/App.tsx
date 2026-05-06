import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"

function Home() {
  return (
    <main style={{
      padding: 32,
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "var(--foreground, #e5e5e5)",
      minHeight: "100vh",
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
      <Home />
    </ViewProvider>
  )
}
