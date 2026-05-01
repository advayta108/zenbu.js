import { ViewProvider } from "#zenbu/init/src/renderer/lib/View"
import { WorkspaceContent } from "./components/workspace-content"

export function App() {
  return (
    <ViewProvider fallback={<div className="h-full" />}>
      <WorkspaceContent />
    </ViewProvider>
  )
}
