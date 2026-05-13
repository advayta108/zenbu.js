import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DesktopLogger {
  /** Absolute path of the log file backing this logger. */
  readonly file: string;
  /** Append a structured step boundary. */
  step(label: string): void;
  /** Append a free-form line (also mirrored to stdout when verbose). */
  info(line: string): void;
  /** Append an error line. Always mirrored to stderr. */
  error(line: string): void;
  /**
   * Run `fn`, logging its start and end with timing. Throws are recorded
   * with the step label and re-thrown.
   */
  withStep<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  /** Last `n` lines of the log file (string, may be empty). */
  tail(n?: number): string;
  /** Close the underlying stream. */
  close(): void;
}

export interface CreateLoggerOpts {
  /** Display slug, used in the log file name. */
  slug: string;
  /** When true, mirror every line to stdout. */
  verbose?: boolean;
}

const LOG_DIR = path.join(os.homedir(), ".zenbu", "logs", "create-zenbu-app");

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createLogger(opts: CreateLoggerOpts): DesktopLogger {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${ts()}-${opts.slug}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  stream.write(
    `=== create-zenbu-app --desktop ${new Date().toISOString()} pid=${process.pid} slug=${opts.slug} ===\n`,
  );

  const writeLine = (prefix: string, line: string): void => {
    const text = `[${new Date().toISOString()}] ${prefix}${line}\n`;
    try {
      stream.write(text);
    } catch {}
    if (opts.verbose) process.stdout.write(text);
  };

  return {
    file,
    step(label) {
      writeLine("[STEP] ", label);
    },
    info(line) {
      writeLine("", line);
    },
    error(line) {
      const text = `[${new Date().toISOString()}] [ERR] ${line}\n`;
      try {
        stream.write(text);
      } catch {}
      process.stderr.write(text);
    },
    async withStep(label, fn) {
      this.step(label);
      const start = Date.now();
      try {
        const out = await fn();
        writeLine("[STEP-OK] ", `${label} (${Date.now() - start}ms)`);
        return out;
      } catch (err) {
        const e = err as Error;
        writeLine(
          "[STEP-FAIL] ",
          `${label} (${Date.now() - start}ms): ${e.stack ?? e.message ?? String(err)}`,
        );
        throw err;
      }
    },
    tail(n = 30) {
      try {
        const all = fs.readFileSync(file, "utf8").split("\n");
        return all.slice(Math.max(0, all.length - n - 1)).join("\n");
      } catch {
        return "";
      }
    },
    close() {
      try {
        stream.end();
      } catch {}
    },
  };
}
