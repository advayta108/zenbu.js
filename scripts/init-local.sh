#!/usr/bin/env bash
# Scaffold a Zenbu app using the LOCAL framework workspace via `link:` deps.
# No packing required: edits to ~/.zenbu/plugins/zenbu/packages/core
# (after rebuilding its dist) will be picked up on the next app restart.
#
# Usage:
#   bash /Users/robby/.zenbu/plugins/zenbu/scripts/init-local.sh <project-name>
#
# Run from the directory you want the new app folder created in.

set -euo pipefail

ZENBU_REPO="/Users/robby/.zenbu/plugins/zenbu"
CREATE_BIN="$ZENBU_REPO/packages/create-zenbu-app/dist/index.mjs"
CORE_PKG="$ZENBU_REPO/packages/core"

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

echo "[init-local] scaffolding $NAME via create-zenbu-app"
node "$CREATE_BIN" "$NAME"

echo "[init-local] rewriting @zenbujs/core to link: workspace path"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const corePath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies["@zenbujs/core"] = "link:" + corePath;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$TARGET_DIR/package.json" "$CORE_PKG"

echo "[init-local] installing with pnpm against the linked dep"
pnpm --dir "$TARGET_DIR" install --no-frozen-lockfile

cat <<EOF

[init-local] done.

  cd $NAME
  pnpm dev

Edits to $CORE_PKG/src
require a rebuild ('pnpm --filter @zenbujs/core build')
and an Electron restart to take effect.
EOF
