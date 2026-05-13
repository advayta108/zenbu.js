import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DesktopLogger } from "./log.js";

export interface PrepareIconOpts {
  /** Path supplied by the user. May be `.icns` or `.png`. */
  source: string;
  /** Destination .icns path inside the bundle's Resources dir. */
  dest: string;
  log: DesktopLogger;
}

const ICONSET_SIZES: Array<{ name: string; px: number }> = [
  { name: "icon_16x16.png", px: 16 },
  { name: "icon_16x16@2x.png", px: 32 },
  { name: "icon_32x32.png", px: 32 },
  { name: "icon_32x32@2x.png", px: 64 },
  { name: "icon_128x128.png", px: 128 },
  { name: "icon_128x128@2x.png", px: 256 },
  { name: "icon_256x256.png", px: 256 },
  { name: "icon_256x256@2x.png", px: 512 },
  { name: "icon_512x512.png", px: 512 },
  { name: "icon_512x512@2x.png", px: 1024 },
];

export async function prepareIcon(opts: PrepareIconOpts): Promise<void> {
  const { source, dest, log } = opts;
  if (!fs.existsSync(source)) {
    throw new Error(`icon source does not exist: ${source}`);
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const ext = path.extname(source).toLowerCase();
  if (ext === ".icns") {
    log.info(`copying icns ${source} -> ${dest}`);
    await fsp.copyFile(source, dest);
    return;
  }
  if (ext !== ".png") {
    throw new Error(
      `unsupported icon format "${ext}". Use .png (square, ideally 1024x1024) or .icns.`,
    );
  }

  log.info(`converting png -> icns (${source})`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "czda-iconset-"));
  const iconset = path.join(tmp, "icon.iconset");
  await fsp.mkdir(iconset, { recursive: true });

  for (const { name, px } of ICONSET_SIZES) {
    const out = path.join(iconset, name);
    const r = spawnSync(
      "sips",
      ["-z", String(px), String(px), source, "--out", out],
      { stdio: "pipe", encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(
        `sips failed for ${name} (${r.status}): ${r.stderr?.slice(0, 500) ?? ""}`,
      );
    }
  }

  const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", dest], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `iconutil failed (${r.status}): ${r.stderr?.slice(0, 500) ?? ""}`,
    );
  }
  await fsp.rm(tmp, { recursive: true, force: true });
}
