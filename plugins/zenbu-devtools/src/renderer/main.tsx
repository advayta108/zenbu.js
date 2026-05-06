import { createRoot } from "react-dom/client"
import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"
import "./app.css"

function Devtools() {
  return (
    <div style={{
      height: "100vh",
      padding: 16,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: 13,
      color: "var(--foreground, #e5e5e5)",
      overflow: "auto",
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Devtools</div>
      <div style={{ color: "var(--muted-foreground, #888)" }}>
        Panel ready. Right-click the main view to toggle.
      </div>
    </div>
  )
}

function App() {
  return (
    <ViewProvider fallback={<div style={{ height: "100vh" }} />}>
      <Devtools />
    </ViewProvider>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
