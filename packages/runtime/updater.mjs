import fs from "node:fs"

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { app } from "electron"
import { EventEmitter } from "node:events"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { createWriteStream } from "node:fs"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFileCb)

const APP_PATH = app.getAppPath()
const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "Zenbu")
const UPDATES_DIR = path.join(CACHE_ROOT, "updates")

function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_PATH, "app-config.json"), "utf8"))
  } catch {
    return {}
  }
}

function getAppBundlePath() {
  let dir = APP_PATH
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith(".app")) return dir
    dir = path.dirname(dir)
  }
  return null
}

class Updater {
  #config = readAppConfig()
  #downloadedZipPath = null
  #stagingDir = null

  async check() {
    const currentVersion = this.#config.version ?? "0.0.0"
    const updateUrl = this.#config.updateUrl

    if (!updateUrl) {
      return { available: false, currentVersion, reason: "no updateUrl configured" }
    }

    try {
      const response = await fetch(updateUrl)
      if (!response.ok) {
        return { available: false, currentVersion, reason: `fetch failed: ${response.status}` }
      }

      const release = await response.json()
      const remoteVersion = (release.tag_name ?? "").replace(/^v/, "")

      if (!remoteVersion || remoteVersion === currentVersion) {
        return { available: false, currentVersion }
      }

      const arch = process.arch === "arm64" ? "arm64" : "x64"
      const asset = release.assets?.find(a =>
        a.name.endsWith(`.zip`) && a.name.includes(`darwin-${arch}`)
      ) ?? release.assets?.[0]

      return {
        available: true,
        version: remoteVersion,
        currentVersion,
        releaseNotes: release.body ?? "",
        size: asset?.size ?? 0,
        downloadUrl: asset?.browser_download_url ?? null,
        assetName: asset?.name ?? null,
      }
    } catch (err) {
      return { available: false, currentVersion, reason: err.message }
    }
  }

  download() {
    const emitter = new EventEmitter()
    const promise = this.#doDownload(emitter)
    emitter.finished = promise
    return emitter
  }

  async #doDownload(emitter) {
    const result = await this.check()
    if (!result.available || !result.downloadUrl) {
      throw new Error("No update available to download")
    }

    const appName = this.#config.name ?? "app"
    const stagingDir = path.join(UPDATES_DIR, appName)
    await fsp.mkdir(stagingDir, { recursive: true })

    const zipPath = path.join(stagingDir, result.assetName ?? "update.zip")

    const response = await fetch(result.downloadUrl, { redirect: "follow" })
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    if (!response.body) throw new Error("No response body")

    const total = Number(response.headers.get("content-length") ?? result.size ?? 0)
    let transferred = 0

    const transform = new TransformStream({
      transform(chunk, controller) {
        transferred += chunk.byteLength
        const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
        emitter.emit("progress", { percent, transferred, total })
        controller.enqueue(chunk)
      },
    })

    const readable = Readable.fromWeb(response.body.pipeThrough(transform))
    await pipeline(readable, createWriteStream(zipPath))

    this.#downloadedZipPath = zipPath
    this.#stagingDir = stagingDir

    emitter.emit("progress", { percent: 100, transferred: total, total })
  }

  async install() {
    if (!this.#downloadedZipPath) {
      throw new Error("No update downloaded. Call download() first.")
    }

    const bundlePath = getAppBundlePath()
    if (!bundlePath) {
      throw new Error("Could not determine .app bundle path")
    }

    const extractDir = path.join(this.#stagingDir, "extracted")
    await fsp.mkdir(extractDir, { recursive: true })
    await execFileAsync("ditto", ["-xk", this.#downloadedZipPath, extractDir])

    const extractedApps = (await fsp.readdir(extractDir)).filter(f => f.endsWith(".app"))
    if (extractedApps.length === 0) {
      throw new Error("No .app found in downloaded archive")
    }

    const newAppPath = path.join(extractDir, extractedApps[0])
    const contentsDir = path.join(bundlePath, "Contents")

    await execFileAsync("rm", ["-rf", path.join(contentsDir, "MacOS")])
    await execFileAsync("rm", ["-rf", path.join(contentsDir, "Frameworks")])
    await execFileAsync("rm", ["-rf", path.join(contentsDir, "Resources")])

    await execFileAsync("cp", ["-c", "-R",
      path.join(newAppPath, "Contents", "MacOS"),
      path.join(contentsDir, "MacOS"),
    ])
    await execFileAsync("cp", ["-c", "-R",
      path.join(newAppPath, "Contents", "Frameworks"),
      path.join(contentsDir, "Frameworks"),
    ])
    await execFileAsync("cp", ["-c", "-R",
      path.join(newAppPath, "Contents", "Resources"),
      path.join(contentsDir, "Resources"),
    ])

    const newPlist = path.join(newAppPath, "Contents", "Info.plist")
    if (fs.existsSync(newPlist)) {
      await fsp.copyFile(newPlist, path.join(contentsDir, "Info.plist"))
    }

    await fsp.rm(this.#stagingDir, { recursive: true, force: true }).catch(() => {})

    app.relaunch()
    app.exit()
  }
}

export const updater = new Updater()
