import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { ensurePublishConfig, readConfig } from "../lib/config"

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, "zenbu.plugin.json"))) return cwd
  console.error("zen publish: no zenbu.plugin.json found in current directory")
  process.exit(1)
}

export async function runPublish(argv: string[]) {
  const projectDir = resolveProjectDir()
  const publishConfig = await ensurePublishConfig(projectDir)
  const config = readConfig(projectDir)
  const appName = config.app?.name ?? path.basename(projectDir)
  const version = config.app?.version ?? "0.0.1"

  const distDir = path.join(projectDir, "dist")
  const appPath = path.join(distDir, `${appName}.app`)

  if (!fs.existsSync(appPath)) {
    console.error(`zen publish: ${appName}.app not found in dist/. Run 'zen build' first.`)
    process.exit(1)
  }

  if (publishConfig.provider === "github") {
    const { owner, repo } = publishConfig
    const token = publishConfig.token === "$GITHUB_TOKEN"
      ? process.env.GITHUB_TOKEN
      : publishConfig.token

    if (!token) {
      console.error("zen publish: GITHUB_TOKEN not set. Export it or configure in zenbu.config.json.")
      process.exit(1)
    }

    const zipPath = path.join(distDir, `${appName}-${version}-darwin-${process.arch}.zip`)
    console.log(`\n  → zipping ${appName}.app...`)
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", appPath, zipPath])

    console.log(`  → creating GitHub release v${version}...`)
    try {
      execFileSync("gh", [
        "release", "create", `v${version}`,
        "--repo", `${owner}/${repo}`,
        "--title", `${appName} v${version}`,
        "--notes", `Release ${version}`,
        zipPath,
      ], { stdio: "inherit" })
    } catch (err: any) {
      if (err.status) {
        console.log(`  → release v${version} may already exist, uploading asset...`)
        execFileSync("gh", [
          "release", "upload", `v${version}`,
          "--repo", `${owner}/${repo}`,
          "--clobber",
          zipPath,
        ], { stdio: "inherit" })
      }
    }

    console.log(`\n  ✓ Published ${appName} v${version} to github.com/${owner}/${repo}\n`)
  } else {
    console.error("zen publish: only 'github' provider is implemented. S3 and custom coming soon.")
    process.exit(1)
  }
}
