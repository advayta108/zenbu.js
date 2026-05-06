#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureBunBootstrapped, runCommand, BUN_BIN } from "../lib/bootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template");
const SUBMODULE_REPO = "https://github.com/zenbu-labs/zenbu.js.git";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith("--")));
const positional = argv.filter(a => !a.startsWith("--"));

const jsonMode = flags.has("--json");
const verbose = flags.has("--verbose");
const silent = !verbose;

function emit(data) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data) + "\n");
  }
}

function log(msg) {
  if (!jsonMode) console.log(msg);
}

function step(id, label, fn) {
  return async () => {
    emit({ step: id, status: "start" });
    log(`  ${label}`);
    try {
      await fn();
      emit({ step: id, status: "done" });
    } catch (err) {
      emit({ step: id, status: "error", message: err.message });
      throw err;
    }
  };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  const projectName = positional[0];
  if (!projectName) {
    console.error("Usage: create-zenbu-app <project-name> [--json] [--verbose]");
    process.exit(1);
  }

  const projectDir = path.resolve(process.cwd(), projectName);
  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir);
    if (entries.length > 0) {
      console.error(`Error: directory "${projectName}" already exists and is not empty.`);
      process.exit(1);
    }
  }

  log(`\nCreating "${projectName}"...\n`);

  await step("scaffold", "Scaffolding project", async () => {
    copyDirSync(TEMPLATE_DIR, projectDir);
    if (fs.existsSync(path.join(projectDir, "_gitignore"))) {
      fs.renameSync(
        path.join(projectDir, "_gitignore"),
        path.join(projectDir, ".gitignore"),
      );
    }
    const pkgPath = path.join(projectDir, "package.json");
    const pkgContent = fs.readFileSync(pkgPath, "utf8");
    fs.writeFileSync(pkgPath, pkgContent.replace(/\{\{projectName\}\}/g, projectName));
    await runCommand("git", ["init"], projectDir, { silent });
    await runCommand("git", ["submodule", "add", SUBMODULE_REPO, "zenbu"], projectDir, { silent });
  })();

  emit({ step: "install", status: "start" });
  log("  Installing dependencies");

  await ensureBunBootstrapped();
  const setupTs = path.join(projectDir, "zenbu", "packages", "init", "setup.ts");

  const frameworkInstall = (async () => {
    emit({ step: "install:framework", status: "start" });
    if (fs.existsSync(setupTs)) {
      await runCommand(BUN_BIN, [setupTs], path.join(projectDir, "zenbu"), {
        env: { ZENBU_CONFIG_PATH: path.join(projectDir, "config.json") },
        silent,
      });
    }
    emit({ step: "install:framework", status: "done" });
  })();

  const appInstall = (async () => {
    emit({ step: "install:app", status: "start" });
    await runCommand("npm", ["install"], projectDir, { silent });
    emit({ step: "install:app", status: "done" });
  })();

  await Promise.all([frameworkInstall, appInstall]);
  emit({ step: "install", status: "done" });

  emit({ status: "done", path: projectDir });
  log(`\nDone! cd ${projectName} && zen open\n`);
}

main().catch((err) => {
  if (!jsonMode) console.error("\nError:", err.message || err);
  process.exit(1);
});
