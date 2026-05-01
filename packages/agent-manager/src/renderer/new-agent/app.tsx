import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"
import { NewAgentScreen } from "./components/new-agent-screen"

export function App() {
  return (
    <ViewProvider fallback={<div className="h-full" />}>
      <NewAgentScreen />
    </ViewProvider>
  )
}
