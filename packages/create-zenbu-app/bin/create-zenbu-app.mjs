#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureBunBootstrapped, runCommand, BUN_BIN } from "../lib/bootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template");
const SUBMODULE_REPO = "https://github.com/zenbu-labs/zenbu.js.git";

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
  const projectName = process.argv[2];
  if (!projectName) {
    console.error("Usage: create-zenbu-app <project-name>");
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

  console.log(`\nCreating Zenbu app in ${projectDir}\n`);

  console.log("→ Copying template files...");
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

  console.log("→ Initializing git repository...");
  await runCommand("git", ["init"], projectDir);

  console.log("→ Adding zenbu.js submodule...");
  await runCommand(
    "git",
    ["submodule", "add", SUBMODULE_REPO, "zenbu"],
    projectDir,
  );

  console.log("→ Bootstrapping toolchain...");
  await ensureBunBootstrapped();

  const setupTs = path.join(projectDir, "zenbu", "packages", "init", "setup.ts");
  if (fs.existsSync(setupTs)) {
    console.log("→ Running framework setup...");
    await runCommand(
      BUN_BIN,
      [setupTs],
      path.join(projectDir, "zenbu"),
      {
        ZENBU_STANDALONE: "1",
        ZENBU_CONFIG_PATH: path.join(projectDir, "config.json"),
      },
    );
  } else {
    console.log("  ⚠ setup.ts not found in submodule, skipping framework setup");
  }

  console.log("→ Installing app dependencies...");
  await runCommand("npm", ["install"], projectDir);

  console.log(`\n✓ Done! Your Zenbu app is ready.\n`);
  console.log(`  cd ${projectName}`);
  console.log(`  zen open\n`);
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
