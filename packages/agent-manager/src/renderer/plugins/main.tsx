import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import "./app.css"

import "#zenbu/init/src/renderer/lib/shortcut-capture"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
