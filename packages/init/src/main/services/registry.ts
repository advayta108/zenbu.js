import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  GitCommandError,
  GitMissingError,
  clone as gitClone,
  getRemoteUrl,
  parseRemoteUrl,
} from "@zenbu/git"
import { Service, runtime } from "../runtime"
import { InstallerService } from "./installer"

const PLUGINS_ROOT = path.join(os.homedir(), ".zenbu", "plugins")
const CORE_REPO_ROOT = path.join(PLUGINS_ROOT, "zenbu")
const LOCAL_REGISTRY_PATH = path.join(CORE_REPO_ROOT, "registry.jsonl")

export type RegistryEntry = {
  name: string
  description: string
  repo: string
}

export type RegistryListing = {
  source: "remote" | "local"
  entries: Array<RegistryEntry & { installed: boolean; installPath: string }>
  warning?: string
}

export type RegistryResult =
  | { ok: true; listing: RegistryListing }
  | { ok: false; error: string }

export type InstallResult =
  | { ok: true; manifestPath: string; log: string[] }
  | { ok: false; error: string; log?: string[] }

function parseJsonl(raw: string): RegistryEntry[] {
  const entries: RegistryEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (
        obj &&
        typeof obj.name === "string" &&
        typeof obj.repo === "string"
      ) {
        entries.push({
          name: obj.name,
          description: typeof obj.description === "string" ? obj.description : "",
          repo: obj.repo,
        })
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries
}

async function fetchRemoteRegistry(): Promise<
  { entries: RegistryEntry[] } | { error: string }
> {
  const remote = await getRemoteUrl(CORE_REPO_ROOT)
  if (!remote) return { error: "No Core remote configured" }
  const parsed = parseRemoteUrl(remote)
  if (!parsed) return { error: `Unrecognised remote URL: ${remote}` }

  const rawUrl =
    parsed.host === "github.com"
      ? `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/registry.jsonl`
      : null
  if (!rawUrl) {
    return { error: `Remote host ${parsed.host} not supported yet` }
  }

  try {
    const response = await fetch(rawUrl, { redirect: "follow" })
    if (!response.ok) {
      return { error: `GET ${rawUrl} → ${response.status} ${response.statusText}` }
    }
    const text = await response.text()
    return { entries: parseJsonl(text) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function readLocalRegistry(): RegistryEntry[] {
  if (!fs.existsSync(LOCAL_REGISTRY_PATH)) return []
  try {
    return parseJsonl(fs.readFileSync(LOCAL_REGISTRY_PATH, "utf8"))
  } catch {
    return []
  }
}

function installPathFor(name: string): string {
  return path.join(PLUGINS_ROOT, name)
}

function isInstalled(name: string): boolean {
  return fs.existsSync(installPathFor(name))
}

function runSetupScript(
  cwd: string,
  script: string,
  onLog: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", [script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    proc.stdout.on("data", (d: Buffer) => {
      const line = d.toString().trim()
      if (line) onLog(line)
    })
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim()
      if (line) onLog(line)
    })
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`setup.sh exited with code ${code}`))
    })
  })
}

function findManifest(dir: string): string | null {
  const root = path.join(dir, "zenbu.plugin.json")
  if (fs.existsSync(root)) return root
  // Shallow search: one level down (e.g., packages/foo/zenbu.plugin.json)
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const sub = path.join(dir, entry.name, "zenbu.plugin.json")
      if (fs.existsSync(sub)) return sub
    }
  } catch {}
  return null
}

export class RegistryService extends Service {
  static key = "registry"
  static deps = { installer: InstallerService }
  declare ctx: { installer: InstallerService }

  evaluate() {}

  async getRegistry(): Promise<RegistryResult> {
    const remote = await fetchRemoteRegistry()
    if ("entries" in remote) {
      return {
        ok: true,
        listing: {
          source: "remote",
          entries: remote.entries.map((e) => ({
            ...e,
            installed: isInstalled(e.name),
            installPath: installPathFor(e.name),
          })),
        },
      }
    }

    const local = readLocalRegistry()
    if (local.length === 0) return { ok: false, error: remote.error }
    return {
      ok: true,
      listing: {
        source: "local",
        warning: `Using local registry (${remote.error})`,
        entries: local.map((e) => ({
          ...e,
          installed: isInstalled(e.name),
          installPath: installPathFor(e.name),
        })),
      },
    }
  }

  async installFromRegistry(entry: RegistryEntry): Promise<InstallResult> {
    const log: string[] = []
    const append = (line: string) => log.push(line)
    try {
      if (!entry.name || !entry.repo) {
        return { ok: false, error: "Missing name or repo" }
      }
      const target = installPathFor(entry.name)
      if (fs.existsSync(target)) {
        return { ok: false, error: `${target} already exists` }
      }
      fs.mkdirSync(PLUGINS_ROOT, { recursive: true })

      append(`Cloning ${entry.repo} → ${target}`)
      await gitClone(entry.repo, target)

      const manifest = findManifest(target)
      if (!manifest) {
        return {
          ok: false,
          error: `No zenbu.plugin.json found in ${target}`,
          log,
        }
      }
      append(`Manifest: ${manifest}`)

      const manifestDir = path.dirname(manifest)
      const setupScript = path.join(manifestDir, "setup.sh")
      if (fs.existsSync(setupScript)) {
        append(`Running setup.sh…`)
        await runSetupScript(manifestDir, setupScript, append)
      } else {
        append("No setup.sh (skipping)")
      }

      this.ctx.installer.addPluginToConfig(manifest)
      append(`Added to config`)

      return { ok: true, manifestPath: manifest, log }
    } catch (err) {
      let message: string
      if (err instanceof GitMissingError) message = "git isn't installed"
      else if (err instanceof GitCommandError)
        message = err.stderr.trim() || err.message
      else if (err instanceof Error) message = err.message
      else message = String(err)
      return { ok: false, error: message, log }
    }
  }
}

runtime.register(RegistryService, (import.meta as any).hot)
