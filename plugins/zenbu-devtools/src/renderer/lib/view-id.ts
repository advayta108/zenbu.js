const params = new URLSearchParams(window.location.search)
export const viewId = params.get("viewId") ?? "devtools-default"
export const windowId = params.get("windowId") ?? "main"
