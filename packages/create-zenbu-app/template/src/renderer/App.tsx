import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"

function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1>Welcome to Zenbu</h1>
      <p>Edit <code>src/renderer/App.tsx</code> to get started.</p>
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
