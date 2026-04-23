const { ipcRenderer } = require("electron")

const labelEl = document.getElementById("label")
const detailEl = document.getElementById("detail")

ipcRenderer.on("zenbu:boot-status", (_event, payload) => {
  if (!payload || typeof payload !== "object") return
  if (typeof payload.message === "string") {
    labelEl.textContent = payload.message
  }
  detailEl.textContent = typeof payload.detail === "string" ? payload.detail : ""
})

ipcRenderer.on("zenbu:boot-error", (_event, payload) => {
  if (!payload || typeof payload !== "object") return
  if (typeof payload.message === "string") {
    labelEl.textContent = payload.message
  }
  detailEl.textContent = typeof payload.detail === "string" ? payload.detail : ""
})
