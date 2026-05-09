#!/usr/bin/env bash
# Scaffold a Zenbu app using the LOCAL framework workspace via `link:` deps.
# No packing required: edits to ~/.zenbu/plugins/zenbu/packages/{core,zen}
# (after rebuilding their dist) will be picked up on the next app restart.
#
# Usage:
#   bash /Users/robby/.zenbu/plugins/zenbu/scripts/init-local.sh <project-name>
#
# Run from the directory you want the new app folder created in.

set -euo pipefail

ZENBU_REPO="/Users/robby/.zenbu/plugins/zenbu"
INIT_BIN="$ZENBU_REPO/packages/init/bin/init.mjs"
CORE_PKG="$ZENBU_REPO/packages/core"
CLI_PKG="$ZENBU_REPO/packages/zen"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <project-name>" >&2
  exit 1
fi

NAME="$1"
TARGET_DIR="$(pwd)/$NAME"

if [ -e "$TARGET_DIR" ]; then
  echo "error: $TARGET_DIR already exists" >&2
  exit 1
fi

echo "[init-local] scaffolding $NAME via packages/init"
node "$INIT_BIN" "$NAME"

echo "[init-local] rewriting deps to link: workspace paths"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const corePath = process.argv[2];
const cliPath = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.dependencies ??= {};
pkg.devDependencies ??= {};
pkg.dependencies["@zenbujs/core"] = "link:" + corePath;
pkg.devDependencies["@zenbujs/cli"] = "link:" + cliPath;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$TARGET_DIR/package.json" "$CORE_PKG" "$CLI_PKG"

echo "[init-local] re-installing with bundled pnpm against the linked deps"
"$TARGET_DIR/.zenbu/toolchain/bin/pnpm" --dir "$TARGET_DIR" install --no-frozen-lockfile

cat <<EOF

[init-local] done.

  cd $NAME
  npm run dev

Edits to $CORE_PKG/src or $CLI_PKG/src
require a rebuild ('pnpm --filter @zenbujs/core build' / 'pnpm --filter
@zenbujs/cli build') and an Electron restart to take effect.
EOF
