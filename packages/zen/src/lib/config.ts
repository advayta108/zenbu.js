import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

export interface ZenbuConfig {
  app?: {
    name?: string
    bundleId?: string
    icon?: string
  }
  signing?: {
    identity?: string
    teamId?: string
    appleId?: string
    notarize?: boolean
  }
  publish?: {
    provider?: "github" | "s3" | "custom"
    owner?: string
    repo?: string
    token?: string
    url?: string
  }
}

const CONFIG_FILENAME = "zenbu.config.json"

export function resolveConfigPath(projectDir: string): string {
  return path.join(projectDir, CONFIG_FILENAME)
}

export function readConfig(projectDir: string): ZenbuConfig {
  const configPath = resolveConfigPath(projectDir)
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"))
  } catch {
    return {}
  }
}

export function writeConfig(projectDir: string, config: ZenbuConfig): void {
  const configPath = resolveConfigPath(projectDir)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
}

const IS_INTERACTIVE = process.stdin.isTTY === true

function createPrompt(): { ask: (question: string, defaultValue?: string) => Promise<string>, close: () => void } {
  if (!IS_INTERACTIVE) {
    return {
      ask(_question: string, defaultValue?: string): Promise<string> {
        return Promise.resolve(defaultValue || "")
      },
      close() {},
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  return {
    ask(question: string, defaultValue?: string): Promise<string> {
      const suffix = defaultValue ? ` (${defaultValue})` : ""
      return new Promise((resolve) => {
        rl.question(`  ? ${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultValue || "")
        })
      })
    },
    close() {
      rl.close()
    },
  }
}

export async function ensureAppConfig(projectDir: string): Promise<Required<ZenbuConfig>["app"]> {
  const config = readConfig(projectDir)
  if (config.app?.name) return config.app as Required<ZenbuConfig>["app"]

  const prompt = createPrompt()
  console.log("\n  App not configured.\n")

  const defaultName = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"))
      return pkg.name ?? path.basename(projectDir)
    } catch {
      return path.basename(projectDir)
    }
  })()

  const name = await prompt.ask("App name", defaultName)
  const defaultBundleId = `dev.zenbu.${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
  const bundleId = await prompt.ask("Bundle ID", defaultBundleId)

  config.app = { ...config.app, name, bundleId }
  writeConfig(projectDir, config)
  console.log(`\n  Saved to ${CONFIG_FILENAME}\n`)
  prompt.close()

  return config.app as Required<ZenbuConfig>["app"]
}

export async function ensureSigningConfig(projectDir: string): Promise<Required<ZenbuConfig>["signing"] | null> {
  const config = readConfig(projectDir)
  if (config.signing?.identity) return config.signing as Required<ZenbuConfig>["signing"]

  if (!IS_INTERACTIVE) return null

  const prompt = createPrompt()
  console.log("\n  Code signing not configured.\n")

  const sign = await prompt.ask("Sign the app? (y/N)")
  if (sign.toLowerCase() !== "y") {
    prompt.close()
    return null
  }

  console.log("  (run `security find-identity -v -p codesigning` to list identities)\n")
  const identity = await prompt.ask("Signing identity")
  const teamId = await prompt.ask("Apple Team ID")
  const notarizeStr = await prompt.ask("Notarize? (y/N)")
  const notarize = notarizeStr.toLowerCase() === "y"

  let appleId = ""
  if (notarize) {
    appleId = await prompt.ask("Apple ID for notarization")
  }

  config.signing = { identity, teamId, appleId, notarize }
  writeConfig(projectDir, config)
  console.log(`\n  Saved to ${CONFIG_FILENAME}\n`)
  prompt.close()

  return config.signing as Required<ZenbuConfig>["signing"]
}

export async function ensurePublishConfig(projectDir: string): Promise<Required<ZenbuConfig>["publish"]> {
  const config = readConfig(projectDir)
  if (config.publish?.provider && config.publish?.owner && config.publish?.repo) {
    return config.publish as Required<ZenbuConfig>["publish"]
  }

  const prompt = createPrompt()
  console.log("\n  Publish channel not configured.\n")

  const provider = await prompt.ask("Provider (github / s3 / custom)", "github") as "github" | "s3" | "custom"

  if (provider === "github") {
    let defaultOwner = ""
    let defaultRepo = ""
    try {
      const { execFileSync } = await import("node:child_process")
      const remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: projectDir, encoding: "utf8",
      }).trim()
      const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
      if (match) {
        defaultOwner = match[1]
        defaultRepo = match[2]
      }
    } catch {}

    const owner = await prompt.ask("GitHub owner", defaultOwner)
    const repo = await prompt.ask("GitHub repo", defaultRepo)
    console.log("  (set GITHUB_TOKEN env var, or paste here)")
    const token = await prompt.ask("GitHub token (leave blank to use $GITHUB_TOKEN)")

    config.publish = {
      provider: "github",
      owner,
      repo,
      token: token || "$GITHUB_TOKEN",
    }
  } else if (provider === "custom") {
    const url = await prompt.ask("Release URL (JSON endpoint)")
    config.publish = { provider: "custom", url }
  }

  writeConfig(projectDir, config)
  console.log(`\n  Saved to ${CONFIG_FILENAME}\n`)
  prompt.close()

  return config.publish as Required<ZenbuConfig>["publish"]
}

export function addPluginToLocalConfig(manifestPath: string): void {
  const configDir = path.join(require("node:os").homedir(), ".zenbu")
  const configJsonc = path.join(configDir, "config.jsonc")
  const configJson = path.join(configDir, "config.json")
  const configPath = fs.existsSync(configJsonc) ? configJsonc : configJson

  let config: { plugins?: string[] } = { plugins: [] }
  try {
    const raw = fs.readFileSync(configPath, "utf8")
    config = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/,\s*([\]}])/g, "$1"))
  } catch {}

  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  if (!plugins.includes(manifestPath)) {
    plugins.push(manifestPath)
  }
  config.plugins = plugins

  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
}
