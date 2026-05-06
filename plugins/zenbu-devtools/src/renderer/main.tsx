import { createRoot } from "react-dom/client"
import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"
import { ShellApp } from "./app"
import "./app.css"

function App() {
  return (
    <ViewProvider fallback={<div style={{ height: "100vh" }} />}>
      <ShellApp />
    </ViewProvider>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
