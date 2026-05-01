// URL parameters passed by the orchestrator when mounting the workspace
// iframe. Read once at module load — the iframe is single-use per
// (windowId, workspaceId), so these never change for a given mount.

const params = new URLSearchParams(window.location.search)
export const windowId = params.get("windowId") ?? ""
export const workspaceIdParam = params.get("workspaceId") ?? ""

if (!windowId) {
  throw new Error("Missing ?windowId= in workspace URL")
}
if (!params.get("wsToken")) {
  throw new Error("Missing ?wsToken= in workspace URL")
}

export function shellViewIdFor(workspaceId: string | null): string | null {
  if (!workspaceId) return null
  return `workspace:${windowId}:${workspaceId}`
}

export const shellViewId = shellViewIdFor(workspaceIdParam || null)
