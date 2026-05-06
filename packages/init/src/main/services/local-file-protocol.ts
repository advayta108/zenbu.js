import fsp from "node:fs/promises"
import path from "node:path"
import { session, net } from "electron"
import { Service, runtime } from "../runtime"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
}

export class LocalFileProtocolService extends Service {
  static key = "local-file-protocol"
  static deps = {}

  evaluate() {
    this.setup("register-protocol", () => {
      const scheme = "zenbu-file"

      session.defaultSession.protocol.handle(scheme, async (request) => {
        const url = new URL(request.url)
        const filePath = decodeURIComponent(url.pathname)

        try {
          await fsp.access(filePath)
        } catch {
          return new Response("Not found", { status: 404 })
        }

        const ext = path.extname(filePath).toLowerCase()
        const mimeType = MIME_TYPES[ext] ?? "application/octet-stream"

        return net.fetch(`file://${filePath}`, {
          headers: { "Content-Type": mimeType },
        })
      })

      console.log(`[local-file-protocol] registered "${scheme}://" protocol`)

      return () => {
        try {
          session.defaultSession.protocol.unhandle(scheme)
        } catch {}
      }
    })
  }
}

runtime.register(LocalFileProtocolService, import.meta)
