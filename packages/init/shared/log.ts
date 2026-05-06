const verbose = process.env.ZENBU_VERBOSE === "1"

export function createLogger(tag: string) {
  const prefix = `[${tag}]`

  function log(...args: unknown[]) {
    console.log(prefix, ...args)
  }

  log.verbose = (...args: unknown[]) => {
    if (verbose) console.log(prefix, ...args)
  }

  log.warn = (...args: unknown[]) => {
    console.warn(prefix, ...args)
  }

  log.error = (...args: unknown[]) => {
    console.error(prefix, ...args)
  }

  return log
}
