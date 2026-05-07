import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Service, runtime } from "../runtime"
import { createLogger } from "../../../shared/log"

const log = createLogger("installer")

type InstalledPlugin = {
  manifestPath: string
  name: string
  services: string[]
}

type RegistryEntry = {
  name: string
  title?: string
  description: string
  repo: string
}

type FileNode = {
  name: string
  path: string
  type: "file" | "directory"
  children?: FileNode[]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function resolveConfigPath(): Promise<string> {
  if (process.env.ZENBU_CONFIG_PATH) return process.env.ZENBU_CONFIG_PATH
  const jsonc = path.join(os.homedir(), ".zenbu", "config.jsonc")
  if (await pathExists(jsonc)) return jsonc
  return path.join(os.homedir(), ".zenbu", "config.json")
}

function parseJsonc(str: string): unknown {
  let result = ""
  let i = 0
  while (i < str.length) {
    if (str[i] === '"') {
      let j = i + 1
      while (j < str.length) {
        if (str[j] === "\\") { j += 2 }
        else if (str[j] === '"') { j++; break }
        else { j++ }
      }
      result += str.slice(i, j)
      i = j
    } else if (str[i] === "/" && str[i + 1] === "/") {
      i += 2
      while (i < str.length && str[i] !== "\n") i++
    } else if (str[i] === "/" && str[i + 1] === "*") {
      i += 2
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++
      i += 2
    } else {
      result += str[i]
      i++
    }
  }
  return JSON.parse(result.replace(/,\s*([\]}])/g, "$1"))
}

async function readZenbuConfig(): Promise<{ plugins: string[] }> {
  const configPath = await resolveConfigPath()
  let raw: string
  try {
    raw = await fsp.readFile(configPath, "utf8")
  } catch {
    return { plugins: [] }
  }
  try {
    const parsed = parseJsonc(raw)
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).plugins)) {
      return { plugins: [] }
    }
    return parsed as { plugins: string[] }
  } catch {
    return { plugins: [] }
  }
}

async function expandGlob(pattern: string): Promise<string[]> {
  const dir = path.dirname(pattern)
  const filePattern = path.basename(pattern)
  const regex = new RegExp(
    "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  )
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((f) => regex.test(f))
    .map((f) => path.resolve(dir, f))
}

async function resolveManifestServices(
  manifestPath: string,
  visited = new Set<string>(),
): Promise<string[]> {
  const resolved = path.resolve(manifestPath)
  if (visited.has(resolved)) return []
  visited.add(resolved)

  let raw: string
  try {
    raw = await fsp.readFile(resolved, "utf8")
  } catch {
    return []
  }
  try {
    const manifest = JSON.parse(raw)
    const entries: string[] = manifest.services ?? []
    const baseDir = path.dirname(resolved)
    const services: string[] = []

    for (const entry of entries) {
      const full = path.resolve(baseDir, entry)
      if (full.includes("*")) {
        for (const file of await expandGlob(full)) {
          services.push(path.relative(baseDir, file))
        }
      } else if (full.endsWith(".json")) {
        services.push(...(await resolveManifestServices(full, visited)))
      } else {
        services.push(path.relative(baseDir, full))
      }
    }
    return services
  } catch {
    return []
  }
}

async function derivePluginName(manifestPath: string): Promise<string> {
  try {
    const raw = await fsp.readFile(manifestPath, "utf8")
    const manifest = JSON.parse(raw)
    if (manifest.name) return manifest.name
  } catch {}
  const dir = path.dirname(path.resolve(manifestPath))
  return path.basename(dir)
}

async function readFileTree(dir: string, depth = 0, maxDepth = 4): Promise<FileNode[]> {
  if (depth >= maxDepth) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const filtered = entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        e.name !== "node_modules" &&
        e.name !== "dist" &&
        e.name !== ".git",
    )
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
  const out: FileNode[] = []
  for (const entry of filtered) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(process.cwd(), fullPath)
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        path: relativePath,
        type: "directory",
        children: await readFileTree(fullPath, depth + 1, maxDepth),
      })
    } else {
      out.push({ name: entry.name, path: relativePath, type: "file" })
    }
  }
  return out
}

export class InstallerService extends Service {
  static key = "installer"
  static deps = {}

  needsSetup = false
  private pluginRoot = ""

  evaluate() {
    this.initState().catch((err) => {
      log.error("init failed:", err)
    })
  }

  private async initState(): Promise<void> {
    const config = (globalThis as any).__zenbu_config__ ?? { plugins: [] }
    if (config.plugins.length > 0) {
      const firstPlugin = config.plugins[0]
      let dir = path.dirname(path.resolve(firstPlugin))
      while (dir !== path.dirname(dir)) {
        if (await pathExists(path.join(dir, "package.json"))) {
          this.pluginRoot = dir
          break
        }
        dir = path.dirname(dir)
      }
    }

    this.needsSetup =
      this.pluginRoot !== "" &&
      !(await pathExists(path.join(this.pluginRoot, "node_modules")))
    log.verbose(`service ready (needsSetup: ${this.needsSetup}, root: ${this.pluginRoot})`)
  }

  getPluginRoot(): string {
    return this.pluginRoot
  }

  async getInstalledPlugins(): Promise<InstalledPlugin[]> {
    const config = await readZenbuConfig()
    const out: InstalledPlugin[] = []
    for (const manifestPath of config.plugins) {
      out.push({
        manifestPath,
        name: await derivePluginName(manifestPath),
        services: await resolveManifestServices(manifestPath),
      })
    }
    return out
  }

  async listPluginsWithStatus(): Promise<
    { manifestPath: string; name: string; enabled: boolean }[]
  > {
    const configPath = await resolveConfigPath()
    let raw: string
    try {
      raw = await fsp.readFile(configPath, "utf8")
    } catch {
      return []
    }
    const results: { manifestPath: string; name: string; enabled: boolean }[] = []
    const pluginLineRe = /^\s*(\/\/)?\s*"([^"]+\.json)"/

    for (const line of raw.split("\n")) {
      const match = line.match(pluginLineRe)
      if (!match) continue
      const commented = !!match[1]
      const manifestPath = match[2]!
      results.push({
        manifestPath,
        name: await derivePluginName(manifestPath),
        enabled: !commented,
      })
    }
    return results
  }

  async addPluginToConfig(manifestPath: string): Promise<void> {
    const configPath = await resolveConfigPath()
    if (!(await pathExists(configPath))) {
      const initial = `{\n  "plugins": [\n    "${manifestPath}",\n  ],\n}\n`
      await fsp.writeFile(configPath, initial)
      return
    }
    const raw = await fsp.readFile(configPath, "utf8")
    const lines = raw.split("\n")

    const pluginLineRe = /^(\s*)(\/\/\s*)?"([^"]+\.json)"/
    let lastPluginIdx = -1
    let arrayCloseIdx = -1
    let pluginsKeyIdx = -1
    let indent = "    "

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (pluginsKeyIdx === -1 && /"plugins"\s*:\s*\[/.test(line)) {
        pluginsKeyIdx = i
        continue
      }
      if (pluginsKeyIdx !== -1) {
        const match = line.match(pluginLineRe)
        if (match) {
          lastPluginIdx = i
          indent = match[1]!
          if (match[3] === manifestPath) return
        }
        if (/^\s*\]/.test(line)) {
          arrayCloseIdx = i
          break
        }
      }
    }

    if (arrayCloseIdx === -1) return

    const newLine = `${indent}"${manifestPath}",`
    const insertAt = lastPluginIdx >= 0 ? lastPluginIdx + 1 : arrayCloseIdx

    if (lastPluginIdx >= 0 && !lines[lastPluginIdx]!.trimEnd().endsWith(",")) {
      lines[lastPluginIdx] = lines[lastPluginIdx]!.replace(/(\s*)$/, ",$1")
    }

    lines.splice(insertAt, 0, newLine)
    await fsp.writeFile(configPath, lines.join("\n"))
  }

  /**
   * Remove a plugin's line from the config entirely (as opposed to
   * `togglePlugin(..., false)` which only comments it out). Used by
   * uninstall flows that also delete the plugin's files, so we don't
   * leave the config pointing at a missing manifest.
   */
  async removePluginFromConfig(manifestPath: string): Promise<void> {
    const configPath = await resolveConfigPath()
    let raw: string
    try {
      raw = await fsp.readFile(configPath, "utf8")
    } catch {
      return
    }
    const lines = raw.split("\n")
    const escaped = manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`^\\s*(//\\s*)?"${escaped}"`)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i]!)) lines.splice(i, 1)
    }
    await fsp.writeFile(configPath, lines.join("\n"))
  }

  async togglePlugin(manifestPath: string, enabled: boolean): Promise<void> {
    const configPath = await resolveConfigPath()
    let raw: string
    try {
      raw = await fsp.readFile(configPath, "utf8")
    } catch {
      return
    }
    const lines = raw.split("\n")
    const escaped = manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`^(\\s*)(//\\s*)?("${escaped}")`)

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(re)
      if (!match) continue
      const indent = match[1]!
      const quoted = match[3]!
      const rest = lines[i]!.slice(match[0].length)
      lines[i] = enabled
        ? `${indent}${quoted}${rest}`
        : `${indent}// ${quoted}${rest}`
      break
    }
    await fsp.writeFile(configPath, lines.join("\n"))
  }

  async getPluginRegistry(): Promise<RegistryEntry[]> {
    const registryPath = path.join(process.cwd(), "registry.jsonl")
    let raw: string
    try {
      raw = await fsp.readFile(registryPath, "utf8")
    } catch {
      return []
    }
    try {
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RegistryEntry)
    } catch {
      return []
    }
  }

  async getFileTree(): Promise<{ cwd: string; tree: FileNode[] }> {
    const cwd = process.cwd()
    return { cwd, tree: await readFileTree(cwd) }
  }

  async runSetup(onProgress: (message: string) => void): Promise<boolean> {
    // Historically this ran `bash setup.sh`. The new convention is
    // `bun setup.ts` driven by the plugin's manifest setup.script field.
    // Accept either (setup.ts preferred) so legacy plugin repos still work.
    const setupTs = path.join(this.pluginRoot, "setup.ts")
    const setupSh = path.join(this.pluginRoot, "setup.sh")
    const bunBin = path.join(
      os.homedir(),
      "Library",
      "Caches",
      "Zenbu",
      "bin",
      "bun",
    )

    let cmd: string
    let args: string[]
    if ((await pathExists(setupTs)) && (await pathExists(bunBin))) {
      cmd = bunBin
      args = [setupTs]
    } else if (await pathExists(setupSh)) {
      cmd = "bash"
      args = [setupSh]
    } else {
      onProgress("No setup script found")
      return false
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd: this.pluginRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      })

      proc.stdout.on("data", (data: Buffer) => {
        const line = data.toString().trim()
        if (line) onProgress(line)
      })

      proc.stderr.on("data", (data: Buffer) => {
        const line = data.toString().trim()
        if (line) onProgress(line)
      })

      proc.on("close", (code) => {
        if (code === 0) resolve(true)
        else reject(new Error(`Setup script failed with code ${code}`))
      })

      proc.on("error", (err) => reject(err))
    })
  }
}

runtime.register(InstallerService, import.meta)
