#!/usr/bin/env bash
# End-to-end smoke test: verifies `zen build:source` and `zen publish:source`
# (init + push) work against real GitHub repos created via the gh CLI.
#
# Treats the host's `gh` auth as the test identity. Creates two repos
# (private source + public release/mirror), runs the full pipeline, asserts
# the expected commits land on the mirror, then deletes both repos via a
# trap so the script is self-cleaning on success and failure.
#
# Usage:
#   bash packages/zen/test/smoke-build-mirror.sh
#
# Requirements:
#   - gh CLI logged in (`gh auth status`)
#   - GITHUB_TOKEN available (typically: `export GITHUB_TOKEN=$(gh auth token)`)
#   - The framework's `@zenbujs/cli` is built (rerun `pnpm -F @zenbujs/cli build`
#     before running if you've made cli changes)

set -euo pipefail

OWNER="$(gh api user --jq .login)"
SRC="$OWNER/zenbu-smoke-source"
MIR="$OWNER/zenbu-smoke-release"
APP_DIR="$HOME/new-zenbu-template-tests/template-smoke"
TMP="$(mktemp -d)"
ZEN="$APP_DIR/node_modules/.bin/zen"

if [[ ! -x "$ZEN" ]]; then
  echo "ERROR: $ZEN not found or not executable" >&2
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  if command -v gh >/dev/null; then
    GITHUB_TOKEN="$(gh auth token)"
    export GITHUB_TOKEN
  fi
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN not set and \`gh auth token\` failed" >&2
  exit 1
fi

cleanup() {
  rm -rf "$TMP"
  if ! gh repo delete "$SRC" --yes 2>/tmp/zen-cleanup-src.log; then
    echo ""
    echo "WARNING: failed to delete $SRC; reason:" >&2
    sed 's/^/  /' /tmp/zen-cleanup-src.log >&2
    echo "  manual cleanup: gh repo delete $SRC --yes" >&2
  fi
  if ! gh repo delete "$MIR" --yes 2>/tmp/zen-cleanup-mir.log; then
    echo "WARNING: failed to delete $MIR; reason:" >&2
    sed 's/^/  /' /tmp/zen-cleanup-mir.log >&2
    echo "  manual cleanup: gh repo delete $MIR --yes" >&2
    echo ""
    echo "  (gh likely needs the delete_repo scope:" >&2
    echo "     gh auth refresh -h github.com -s delete_repo)" >&2
  fi
}
trap cleanup EXIT

# In case a prior run left them around.
gh repo delete "$SRC" --yes 2>/dev/null || true
gh repo delete "$MIR" --yes 2>/dev/null || true

echo "==> Creating source ($SRC, private) and release ($MIR, public) repos"
gh repo create "$SRC" --private --description "zenbu smoke source"
gh repo create "$MIR" --public  --description "zenbu smoke release"

# Wait briefly for the repos to materialize on GitHub.
sleep 2

echo "==> Seeding source repo from template-smoke"
cp -R "$APP_DIR" "$TMP/src"
rm -rf "$TMP/src/.git" "$TMP/src/node_modules" "$TMP/src/.zenbu/source" \
       "$TMP/src/.zenbu/desktop-staging" "$TMP/src/dist" 2>/dev/null || true

cat > "$TMP/src/zenbu.build.ts" <<EOF
import { defineBuildConfig, stripIfDisabled, dropFiles } from "@zenbujs/cli/build"
export default defineBuildConfig({
  source: ".",
  out: ".zenbu/source",
  include: [
    "src/**/*",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "zenbu.plugin.json",
    "config.json",
    "db/**",
    "db.config.ts",
    "vite.config.ts",
    "loading.html",
  ],
  ignore: [
    "src/**/*.test.ts",
    "src/**/*.spec.ts",
    "src/dev-only/**",
  ],
  transforms: [stripIfDisabled({ FLAG_BETA: false }), dropFiles(/\.stories\.tsx?$/)],
  mirror: { target: "$MIR", branch: "main" },
})
EOF

# Symlink the framework's node_modules into the test copy so we don't have
# to reinstall — the @zenbujs/cli inside is what we want to exercise.
ln -s "$APP_DIR/node_modules" "$TMP/src/node_modules"

cd "$TMP/src"
git init -q -b main
git -c user.email=smoke@zenbu.dev -c user.name=zenbu-smoke add -A
git -c user.email=smoke@zenbu.dev -c user.name=zenbu-smoke \
  commit -q -m "initial template-smoke import"
git remote add origin "https://github.com/$SRC.git"
git push -q -u origin main

PASS_COUNT=0
fail() { echo "  FAIL: $1"; exit 1; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "  PASS"; }

echo "==> Test 1: build:source is pure (writes staging only, no remote)"
"$ZEN" build:source >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "build:source failed"; }
test -d .zenbu/source || fail "no staging dir"
test -f .zenbu/source/.sha || fail "no .sha marker"
pass

echo "==> Test 2: publish:source push fails before init"
if "$ZEN" publish:source push >/tmp/zen-smoke.log 2>&1; then
  cat /tmp/zen-smoke.log
  fail "publish:source push should have errored"
fi
if ! grep -qiE "not initialized|empty|init" /tmp/zen-smoke.log; then
  cat /tmp/zen-smoke.log
  fail "expected 'not initialized' / 'init' in error output"
fi
pass

echo "==> Test 3: publish:source init seeds empty mirror"
"$ZEN" publish:source init >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "init failed"; }
SRC_SHA="$(git rev-parse HEAD)"
sleep 1
MIRROR_MSG="$(gh api "repos/$MIR/commits/main" --jq .commit.message)"
echo "$MIRROR_MSG" | grep -q "synced from $SRC_SHA" || {
  echo "mirror commit message: $MIRROR_MSG"
  fail "mirror missing [synced from $SRC_SHA] trailer"
}
pass

echo "==> Test 4: publish:source init refuses to re-init"
if "$ZEN" publish:source init >/tmp/zen-smoke.log 2>&1; then
  cat /tmp/zen-smoke.log
  fail "second init should have errored"
fi
grep -qiE "already initialized|force" /tmp/zen-smoke.log || {
  cat /tmp/zen-smoke.log
  fail "expected 'already initialized' message"
}
pass

echo "==> Test 5: edit source, rebuild, publish push -> new mirror commit"
echo "// touched at $(date)" >> src/main/services/ticker.ts
git -c user.email=smoke@zenbu.dev -c user.name=zenbu-smoke commit -aq -m "tweak ticker"
NEW_SRC_SHA="$(git rev-parse HEAD)"
"$ZEN" build:source >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "rebuild failed"; }
"$ZEN" publish:source push >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "push failed"; }
sleep 1
MIRROR_MSG="$(gh api "repos/$MIR/commits/main" --jq .commit.message)"
echo "$MIRROR_MSG" | grep -q "synced from $NEW_SRC_SHA" || {
  echo "mirror commit message: $MIRROR_MSG"
  fail "mirror missing new SHA"
}
pass

echo "==> Test 6: publish:source push with stale staging errors"
echo "// untouched in staging" >> src/main/services/ticker.ts
git -c user.email=smoke@zenbu.dev -c user.name=zenbu-smoke commit -aq -m "another tweak"
if "$ZEN" publish:source push >/tmp/zen-smoke.log 2>&1; then
  cat /tmp/zen-smoke.log
  fail "stale-staging push should have errored"
fi
grep -qi "stale" /tmp/zen-smoke.log || {
  cat /tmp/zen-smoke.log
  fail "expected 'stale' in error output"
}
pass

echo "==> Test 7: rebuild + push when source unchanged is a no-op"
"$ZEN" build:source >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "rebuild failed"; }
"$ZEN" publish:source push >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "push failed"; }
"$ZEN" publish:source push >/tmp/zen-smoke.log 2>&1 || { cat /tmp/zen-smoke.log; fail "second push failed"; }
grep -qi "up to date\|nothing to push" /tmp/zen-smoke.log || {
  cat /tmp/zen-smoke.log
  fail "expected 'up to date' in second push output"
}
pass

echo ""
echo "==> All $PASS_COUNT smoke tests passed."
