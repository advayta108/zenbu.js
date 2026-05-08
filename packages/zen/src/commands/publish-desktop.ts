import { buildDesktop } from "./build-desktop"

interface PublishFlags {
  config?: string
  out?: string
  noSource: boolean
  noSign: boolean
  target?: string[]
}

function parseFlags(argv: string[]): PublishFlags {
  const flags: PublishFlags = { noSource: false, noSign: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--config" || arg === "-c") flags.config = argv[++i]
    else if (arg.startsWith("--config=")) flags.config = arg.slice("--config=".length)
    else if (arg === "--out" || arg === "-o") flags.out = argv[++i]
    else if (arg.startsWith("--out=")) flags.out = arg.slice("--out=".length)
    else if (arg === "--no-source") flags.noSource = true
    else if (arg === "--no-sign") flags.noSign = true
    else if (arg === "--target" || arg === "-t") {
      flags.target = (argv[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--target=")) {
      flags.target = arg.slice("--target=".length).split(",").filter(Boolean)
    }
  }
  return flags
}

/**
 * `zen publish:desktop` is a thin wrapper around `zen build:desktop` that
 * additionally hands electron-builder the GitHub publish config and runs
 * with `--publish always`. The build, sign, notarize, and upload steps are
 * all handled by electron-builder in a single invocation — we don't shell
 * out to `gh` or maintain a separate upload path.
 */
export async function runPublishDesktop(argv: string[]): Promise<void> {
  await buildDesktop(parseFlags(argv), { publish: true })
}
