import { createServer, type ViteDevServer } from "vite"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { access, mkdir, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer as createNetServer } from "node:net"
import { Service, runtime } from "../runtime"
import { INTERNAL_DIR } from "../shared/paths"
import { createLogger } from "../shared/log"

const log = createLogger("reloader")

interface RendererServerOptions {
  id: string
  root: string
  port?: number
  configFile?: string | false
  cacheDir?: string
  plugins?: any[]
  reactPlugin?: () => any
  resolve?: any
}

function safeCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "renderer"
}

function resolveRendererCacheDir(options: RendererServerOptions): string {
  const hash = createHash("sha256")
    .update(options.id)
    .update("\0")
    .update(resolve(options.root))
    .update("\0")
    .update(options.configFile ? resolve(options.configFile) : "no-config")
    .digest("hex")
    .slice(0, 12)

  return resolve(INTERNAL_DIR, "vite-cache", `${safeCacheSegment(options.id)}-${hash}`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function rendererWarmupUrls(root: string): Promise<string[]> {
  const urls = new Set<string>()
  if (await fileExists(resolve(root, "main.tsx"))) {
    urls.add("/main.tsx")
  }

  const viewsDir = resolve(root, "views")
  try {
    for (const entry of await readdir(viewsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (await fileExists(resolve(viewsDir, entry.name, "main.tsx"))) {
        urls.add(`/views/${entry.name}/main.tsx`)
      }
    }
  } catch {}

  return [...urls]
}

async function warmupRendererEntrypoints(server: ViteDevServer, root: string): Promise<void> {
  try {
    const urls = await rendererWarmupUrls(root)
    await Promise.all(urls.map((url) => server.warmupRequest(url)))
  } catch (e) {
    log.warn("renderer warmup failed:", e)
  }
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

async function startRendererServer(options: RendererServerOptions): Promise<ViteDevServer> {
  let server: ViteDevServer

  const port = options.port || await getEphemeralPort()
  const cacheDir = options.cacheDir ?? resolveRendererCacheDir(options)
  await mkdir(cacheDir, { recursive: true })

  const sharedConfig = {
    cacheDir,
    server: {
      port,
      strictPort: true,
      hmr: { protocol: "ws", host: "localhost" } as const,
      fs: { strict: false },
    },
    logLevel: "warn" as const,
  }

  if (options.configFile) {
    server = await createServer({
      ...sharedConfig,
      root: options.root,
      configFile: options.configFile,
    })
  } else {
    const plugins: any[] = [...(options.plugins ?? [])]
    if (options.reactPlugin) {
      plugins.unshift(options.reactPlugin())
    } else {
      try {
        const react = await import("@vitejs/plugin-react")
        plugins.unshift(react.default())
      } catch {}
    }

    server = await createServer({
      ...sharedConfig,
      root: options.root,
      plugins,
      resolve: options.resolve,
      configFile: false,
    })
  }

  await server.listen()

  const addr = server.httpServer?.address()
  const assignedPort = typeof addr === "object" && addr ? addr.port : 0
  if (assignedPort) {
    const hmr = server.config.server.hmr
    if (typeof hmr === "object") {
      ;(hmr as any).clientPort = assignedPort
    }
  }

  await warmupRendererEntrypoints(server, options.root)

  return server
}

export interface ReloaderEntry {
  id: string
  root: string
  url: string
  port: number
  viteServer: ViteDevServer
}

export class ReloaderService extends Service {
  static key = "reloader"
  static deps = {}

  private servers = new Map<string, ReloaderEntry>()

  async create(id: string, root: string, configFile?: string | false): Promise<ReloaderEntry> {
    if (this.servers.has(id)) return this.servers.get(id)!

    const viteServer = await startRendererServer({
      id,
      root,
      configFile: configFile ?? false,
      port: 0,
    })
    const address = viteServer.httpServer?.address()
    const port = typeof address === "object" && address ? address.port : 5173
    const entry: ReloaderEntry = { id, root, url: `http://localhost:${port}`, port, viteServer }
    this.servers.set(id, entry)
    log.verbose(`${id} ready at ${entry.url}`)
    return entry
  }

  get(id: string): ReloaderEntry | undefined {
    return this.servers.get(id)
  }

  async remove(id: string) {
    const entry = this.servers.get(id)
    if (entry) {
      await entry.viteServer.close()
      this.servers.delete(id)
    }
  }

  evaluate() {
    this.setup("vite-cleanup", () => {
      return async () => {
        // Close each server independently — a single throw must NOT
        // skip the rest, otherwise orphan chokidar+fsevents watchers
        // survive shutdown and trip `napi_call_function` in
        // `fse_dispatch_event` once the V8 isolate tears down. Use
        // `allSettled` so every server gets a close attempt and we can
        // log every failure individually.
        const entries = [...this.servers.values()]
        this.servers.clear()
        const results = await Promise.allSettled(
          entries.map((entry) => entry.viteServer.close()),
        )
        results.forEach((res, i) => {
          if (res.status === "rejected") {
            log.error(
              `viteServer.close failed for ${entries[i].id}:`,
              res.reason,
            )
          }
        })
      }
    })

    log.verbose(`service ready (${this.servers.size} servers)`)
  }
}

runtime.register(ReloaderService, import.meta)
