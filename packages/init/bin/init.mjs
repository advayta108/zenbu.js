#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommand } from "../lib/bootstrap.mjs";
import { ensureRuntimeTools } from "../lib/runtime-tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith("--")));
const positional = argv.filter(a => !a.startsWith("--"));

const jsonMode = flags.has("--json");
const verbose = flags.has("--verbose");
const yes = flags.has("--yes") || flags.has("-y");
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

function renderTemplate(value, projectName) {
  return value.replace(/\{\{projectName\}\}/g, projectName);
}

function copyDirSync(src, dest, projectName) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const name = entry.name.endsWith(".tmpl")
      ? entry.name.slice(0, -".tmpl".length)
      : entry.name;
    const destPath = path.join(dest, name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, projectName);
    } else {
      const content = fs.readFileSync(srcPath, "utf8");
      fs.writeFileSync(destPath, renderTemplate(content, projectName));
    }
  }
}

function rewriteDepsForLocalDev(projectDir) {
  if (process.env.ZENBU_INIT_LOCAL_DEV !== "1") return;
  const packDir = path.join(REPO_ROOT, "dist", "packages");
  const corePack = path.join(packDir, "zenbujs-core-0.0.0.tgz");
  const cliPack = path.join(packDir, "zenbujs-cli-0.0.0.tgz");
  if (!fs.existsSync(corePack) || !fs.existsSync(cliPack)) {
    throw new Error(
      `Local Zenbu package tarballs are missing. Run \`pnpm run pack:local\` in ${REPO_ROOT}.`,
    );
  }
  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  pkg.dependencies["@zenbujs/core"] = `file:${corePack}`;
  pkg.devDependencies["@zenbujs/cli"] = `file:${cliPack}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

async function main() {
  const projectName = positional[0] ?? ".";
  if (projectName === "." && !yes) {
    console.error("Usage: npx @zenbujs/init <project-name> OR npx @zenbujs/init --yes");
    process.exit(1);
  }

  const projectDir = path.resolve(process.cwd(), projectName);
  const displayName = projectName === "." ? path.basename(projectDir) : projectName;
  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir);
    const allowedExisting = projectName === "." && fs.existsSync(path.join(projectDir, "package.json"));
    if (entries.length > 0 && !allowedExisting) {
      console.error(`Error: directory "${projectName}" already exists and is not empty.`);
      process.exit(1);
    }
  }

  log(`\nInitializing Zenbu in "${displayName}"...\n`);

  await step("scaffold", "Scaffolding project", async () => {
    copyDirSync(TEMPLATE_DIR, projectDir, displayName);
    if (fs.existsSync(path.join(projectDir, "_gitignore"))) {
      fs.renameSync(
        path.join(projectDir, "_gitignore"),
        path.join(projectDir, ".gitignore"),
      );
    }
    if (!fs.existsSync(path.join(projectDir, ".git"))) {
      await runCommand("git", ["init"], projectDir, { silent });
    }
    rewriteDepsForLocalDev(projectDir);
  })();

  emit({ step: "runtime-tools", status: "start" });
  log("  Setting up Zenbu runtime");
  const tools = await ensureRuntimeTools(projectDir, { silent });
  emit({ step: "runtime-tools", status: "done" });

  emit({ step: "install", status: "start" });
  log("  Installing dependencies");

  await runCommand(tools.pnpm, ["install"], projectDir, { silent });
  emit({ step: "install", status: "done" });

  emit({ status: "done", path: projectDir });
  log(`\nDone! cd ${projectName === "." ? "." : displayName} && npm run dev\n`);
}

main().catch((err) => {
  if (!jsonMode) console.error("\nError:", err.message || err);
  process.exit(1);
});
