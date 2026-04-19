import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/**
 * Cold-path fallback that mirrors `InstallerService.addPluginToConfig` —
 * used by `zen init` when the app isn't running. Preserves JSONC comments
 * and trailing commas. Prefer the RPC path when the app is up.
 */
function resolveConfigPath(): string {
  const dir = path.join(os.homedir(), ".zenbu")
  const jsonc = path.join(dir, "config.jsonc")
  if (fs.existsSync(jsonc)) return jsonc
  return path.join(dir, "config.json")
}

export function addPluginToLocalConfig(manifestPath: string): void {
  const configPath = resolveConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })

  if (!fs.existsSync(configPath)) {
    const initial = `{\n  "plugins": [\n    "${manifestPath}",\n  ],\n}\n`
    fs.writeFileSync(configPath, initial)
    return
  }

  const raw = fs.readFileSync(configPath, "utf8")
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
  fs.writeFileSync(configPath, lines.join("\n"))
}
