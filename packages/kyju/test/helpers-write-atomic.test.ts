import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { FileSystem } from "@effect/platform";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import {
  cleanupStaleTmpFiles,
  readJsonFile,
  writeJsonFile,
} from "../src/v2/db/helpers";

/**
 * Tests for the atomic JSON write helper used to persist `root.json`
 * (and other DB metadata). Pre-atomic: a process kill mid-write left
 * the file truncated to zero bytes, then every subsequent boot crashed
 * with `SyntaxError: Unexpected end of JSON input` from `JSON.parse`.
 *
 * The atomic implementation writes to `${path}.tmp-<nanoid>` and renames
 * over the destination — `rename(2)` is atomic within a filesystem, so
 * readers see either the old contents or the new contents, never empty.
 */

const runFs = <A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(NodeContext.layer)) as any) as Promise<A>;

let dir: string;
beforeEach(() => {
  dir = path.join(os.tmpdir(), `kyju-helpers-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("writeJsonFile", () => {
  it("writes JSON that round-trips through readJsonFile", async () => {
    const target = path.join(dir, "root.json");
    const data = { a: 1, b: [2, 3], c: { d: "x" } };
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({ fs, path: target, data });
      }),
    );

    const round = await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* readJsonFile({ fs, path: target });
      }),
    );
    expect(round).toEqual(data);
  });

  it("does not leave a tmp file behind on success", async () => {
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({ fs, path: target, data: { ok: true } });
      }),
    );
    const stragglers = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("root.json.tmp-"));
    expect(stragglers).toEqual([]);
  });

  it("never leaves the destination empty (rename is atomic)", async () => {
    // Simulate the failure mode that motivated atomicity: a process is
    // killed *between* truncation and write completion. With a non-atomic
    // `writeFileString` the destination is empty until the write
    // finishes; with the rename-over-tmp pattern the destination either
    // doesn't exist yet or contains the previous full contents.
    const target = path.join(dir, "root.json");

    // Seed a previous good payload.
    fs.writeFileSync(target, JSON.stringify({ version: 1, data: "old" }));
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      version: 1,
      data: "old",
    });

    // Now perform an atomic write. Even if we observe the destination
    // mid-flight, it's never empty — it's the old contents or the new.
    const writePromise = runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({
          fs,
          path: target,
          data: { version: 2, data: "new".repeat(10000) },
        });
      }),
    );

    // Race a few reads against the write — every observation must be
    // valid JSON, never empty.
    const observations: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        observations.push(fs.readFileSync(target, "utf-8"));
      } catch {}
      await new Promise((r) => setImmediate(r));
    }
    await writePromise;
    observations.push(fs.readFileSync(target, "utf-8"));

    for (const content of observations) {
      expect(content.length).toBeGreaterThan(0);
      // Should not throw — atomic writes never expose partial JSON.
      JSON.parse(content);
    }

    // Final state is the new payload.
    const final = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(final.version).toBe(2);
  });

  it("overwrites existing files cleanly", async () => {
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeJsonFile({ fs, path: target, data: { v: 1 } });
        yield* writeJsonFile({ fs, path: target, data: { v: 2 } });
        yield* writeJsonFile({ fs, path: target, data: { v: 3 } });
      }),
    );
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ v: 3 });
  });

  it("cleanupStaleTmpFiles removes orphaned *.tmp-<id> files", async () => {
    // Simulate stragglers left by a hard-killed previous process.
    fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(dir, "root.json.tmp-abc12345"), "partial");
    fs.writeFileSync(path.join(dir, "blobs.json.tmp-xyz98765"), "partial2");
    // Files we MUST NOT touch — no `.tmp-` infix.
    fs.writeFileSync(path.join(dir, "real-data.json"), "{}");
    fs.writeFileSync(path.join(dir, "weird-name.tmpfoo"), "{}");
    // Subdirectory with another straggler — sweep recurses.
    const sub = path.join(dir, "collections", "messages");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "page.json.tmp-deadbeef"), "p");
    fs.writeFileSync(path.join(sub, "page.json"), "{}");

    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cleanupStaleTmpFiles(fs, dir);
      }),
    );

    const top = fs.readdirSync(dir).sort();
    expect(top).toEqual(["collections", "real-data.json", "root.json", "weird-name.tmpfoo"]);
    const subEntries = fs.readdirSync(sub).sort();
    expect(subEntries).toEqual(["page.json"]);
  });

  it("cleanupStaleTmpFiles is a no-op when dbPath doesn't exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cleanupStaleTmpFiles(fs, missing);
      }),
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("uses unique tmp paths so concurrent writes don't clobber each other", async () => {
    // If two writes raced through a fixed `${path}.tmp` filename one
    // could rename a partial of the other. nanoid suffixes prevent that.
    const target = path.join(dir, "root.json");
    await runFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.all(
          [
            writeJsonFile({ fs, path: target, data: { who: "a" } }),
            writeJsonFile({ fs, path: target, data: { who: "b" } }),
            writeJsonFile({ fs, path: target, data: { who: "c" } }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    const final = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(["a", "b", "c"]).toContain(final.who);

    // No leftover tmp files regardless of race ordering.
    const stragglers = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("root.json.tmp-"));
    expect(stragglers).toEqual([]);
  });
});
