import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { KyjuMigration } from "../v2/migrations";
import type { Journal } from "./generator";

function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

function readJournalFromDir(dir: string): Journal {
  const journalPath = path.join(dir, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return { version: "1", entries: [] };
  }
  return JSON.parse(fs.readFileSync(journalPath, "utf-8"));
}

/**
 * Load migrations from a kyju output directory by reading the journal
 * and dynamically importing each migration file in order.
 */
export async function loadMigrationsFromDir(dir: string): Promise<KyjuMigration[]> {
  const absDir = path.resolve(dir);
  const journal = readJournalFromDir(absDir);

  if (journal.entries.length === 0) return [];

  const migrations: KyjuMigration[] = [];

  for (const entry of journal.entries) {
    const base = `${pad(entry.idx)}_${entry.tag}`;
    const candidates = [".ts", ".js", ".mjs"];
    let filePath: string | null = null;
    for (const ext of candidates) {
      const candidate = path.join(absDir, base + ext);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) {
      throw new Error(
        `Migration file not found for entry ${entry.idx} (${entry.tag}) in ${absDir}`,
      );
    }

    const mod = await import(pathToFileURL(filePath).href);
    const migration: KyjuMigration = mod.default ?? mod;
    migrations.push(migration);
  }

  return migrations;
}
