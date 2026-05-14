#!/usr/bin/env node
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const child = spawn(
  "npx",
  ["-y", "create-zenbu-app@latest", "--desktop", ...args],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  console.error("create-desktop-app: failed to spawn npx:", err.message);
  process.exit(1);
});
