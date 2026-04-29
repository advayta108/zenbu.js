import os from "node:os"

const ESC = "\x1b["
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`
const CLEAR_LINE = `${ESC}2K`
const UP = (n: number) => `${ESC}${n}A`

export type PickerOption<T> = {
  value: T
  label: string
  detail?: string
}

const tty = () => process.stdout.isTTY && process.stdin.isTTY

export const c = {
  reset: () => (tty() ? "\x1b[0m" : ""),
  dim: (s: string) => (tty() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty() ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty() ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (tty() ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty() ? `\x1b[33m${s}\x1b[0m` : s),
  magenta: (s: string) => (tty() ? `\x1b[35m${s}\x1b[0m` : s),
}

export function tildify(p: string): string {
  const home = os.homedir()
  if (p === home) return "~"
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length)
  return p
}

export function relTime(ms: number): string {
  if (!ms) return "—"
  const diff = Date.now() - ms
  if (diff < 0) return "in the future"
  const s = Math.round(diff / 1000)
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

/**
 * Arrow-key list picker. Returns the chosen index or null if user aborted
 * (Esc / Ctrl-C). Falls back to a stdin number prompt when stdout isn't a
 * TTY so piping/CI doesn't hang.
 */
export async function pickOne<T>(
  title: string,
  options: PickerOption<T>[],
  initialIndex = 0,
): Promise<number | null> {
  if (options.length === 0) return null
  if (!tty()) {
    return await numberPrompt(title, options, initialIndex)
  }

  const stdin = process.stdin
  const stdout = process.stdout
  let idx = Math.max(0, Math.min(initialIndex, options.length - 1))

  const render = (first: boolean) => {
    if (!first) stdout.write(UP(options.length + 1))
    stdout.write(`${CLEAR_LINE}${title}\n`)
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!
      const selected = i === idx
      const arrow = selected ? c.cyan("›") : " "
      const label = selected ? c.bold(opt.label) : opt.label
      const detail = opt.detail ? ` ${c.dim(opt.detail)}` : ""
      stdout.write(`${CLEAR_LINE}${arrow} ${label}${detail}\n`)
    }
  }

  stdout.write(HIDE_CURSOR)
  render(true)

  return new Promise<number | null>((resolve) => {
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    const cleanup = (result: number | null) => {
      stdin.off("data", onData)
      stdin.setRawMode?.(wasRaw ?? false)
      stdin.pause()
      stdout.write(SHOW_CURSOR)
      resolve(result)
    }

    const onData = (data: string) => {
      // Up: \x1b[A  Down: \x1b[B  Enter: \r or \n  Esc: \x1b  Ctrl-C: \x03
      if (data === "\x03" || data === "\x1b") return cleanup(null)
      if (data === "\r" || data === "\n") return cleanup(idx)
      if (data === "\x1b[A" || data === "k") {
        idx = (idx - 1 + options.length) % options.length
        render(false)
        return
      }
      if (data === "\x1b[B" || data === "j") {
        idx = (idx + 1) % options.length
        render(false)
        return
      }
      // Number shortcut (1-9)
      const n = Number(data)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        idx = n - 1
        render(false)
      }
    }

    stdin.on("data", onData)
  })
}

async function numberPrompt<T>(
  title: string,
  options: PickerOption<T>[],
  initialIndex: number,
): Promise<number | null> {
  process.stdout.write(`${title}\n`)
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!
    const detail = opt.detail ? ` ${opt.detail}` : ""
    process.stdout.write(`  ${i + 1}. ${opt.label}${detail}\n`)
  }
  process.stdout.write(`Choose [1-${options.length}] (default ${initialIndex + 1}): `)

  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.resume()
    const onData = (data: string) => {
      buf += data
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      process.stdin.off("data", onData)
      process.stdin.pause()
      const trimmed = buf.slice(0, nl).trim()
      if (!trimmed) return resolve(initialIndex)
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 1 || n > options.length) {
        return resolve(null)
      }
      resolve(n - 1)
    }
    process.stdin.on("data", onData)
  })
}

export async function readLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.resume()
    const onData = (data: string) => {
      buf += data
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      process.stdin.off("data", onData)
      process.stdin.pause()
      resolve(buf.slice(0, nl).trimEnd() || null)
    }
    process.stdin.on("data", onData)
  })
}
