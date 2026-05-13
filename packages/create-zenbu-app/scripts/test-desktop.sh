#!/usr/bin/env bash
# End-to-end smoke test for `create-zenbu-app --desktop`.
#
#   1. Build create-zenbu-app + @zenbujs/core (so launcher.mjs is fresh).
#   2. Scaffold a uniquely-named app via the freshly-built CLI.
#   3. Run static assertions against the produced bundle / appsDir.
#   4. Launch the bundle with ZENBU_AUTO_QUIT_AFTER_READY_MS so it self-
#      terminates a few seconds after `app.whenReady()`.
#   5. Bound the launch with `timeout`; on hang, kill -9 and dump logs.
#   6. Cleanup unless KEEP=1 is set.
#
# Re-runnable as many times as you want — each run picks a unique slug.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CREATE_DIR="$REPO_ROOT/packages/create-zenbu-app"
CORE_DIR="$REPO_ROOT/packages/core"

NAME="${NAME:-ZenbuTest$(date +%s)}"
SLUG="$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
DEST_APP="/Applications/${NAME}.app"
APPS_DIR="$HOME/.zenbu/apps/${SLUG}"
LAUNCH_TIMEOUT="${LAUNCH_TIMEOUT:-45}"
AUTO_QUIT_MS="${AUTO_QUIT_MS:-3000}"
KEEP="${KEEP:-0}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    blue "KEEP=1, leaving $DEST_APP and $APPS_DIR in place"
    return
  fi
  if [[ -e "$DEST_APP" ]]; then
    blue "cleanup: rm -rf $DEST_APP"
    rm -rf "$DEST_APP" || true
  fi
  if [[ -e "$APPS_DIR" ]]; then
    blue "cleanup: rm -rf $APPS_DIR"
    rm -rf "$APPS_DIR" || true
  fi
  pkill -9 -f "${NAME}.app" 2>/dev/null || true
}

assert() {
  local desc="$1"; shift
  if "$@"; then
    green "  ok: $desc"
  else
    red "  FAIL: $desc"
    return 1
  fi
}

dump_logs_on_fail() {
  red "==== last create-zenbu-app log ===="
  ls -t "$HOME/.zenbu/logs/create-zenbu-app/"*"-${SLUG}.log" 2>/dev/null | head -1 | xargs -r tail -200 || true
  red "==== last app runtime log ===="
  if [[ -f "$HOME/Library/Logs/${NAME}/main.log" ]]; then
    tail -200 "$HOME/Library/Logs/${NAME}/main.log"
  else
    echo "(no $HOME/Library/Logs/${NAME}/main.log)"
  fi
  red "==== launcher's per-pid log (~/.zenbu/.internal/launcher.log tail) ===="
  tail -100 "$HOME/.zenbu/.internal/launcher.log" 2>/dev/null || true
}

trap cleanup EXIT
trap 'red "interrupted"; dump_logs_on_fail; exit 130' INT TERM

blue "=== test-desktop ==="
echo "  REPO_ROOT=$REPO_ROOT"
echo "  NAME=$NAME"
echo "  SLUG=$SLUG"
echo "  DEST_APP=$DEST_APP"
echo "  APPS_DIR=$APPS_DIR"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  blue "[1/6] build @zenbujs/core"
  (cd "$CORE_DIR" && pnpm run build >/tmp/core-build.log 2>&1) || {
    red "core build failed; see /tmp/core-build.log"; exit 1;
  }
  blue "[2/6] build create-zenbu-app"
  (cd "$CREATE_DIR" && pnpm run build >/tmp/cza-build.log 2>&1) || {
    red "cza build failed; see /tmp/cza-build.log"; exit 1;
  }
fi

blue "[3/6] scaffold $NAME"
ARGS=("$NAME" --desktop --yes --verbose --force)
if [[ -n "${ICON:-}" ]]; then
  ARGS+=(--icon "$ICON")
fi
if [[ -n "${ELECTRON_VERSION:-}" ]]; then
  ARGS+=(--electron-version "$ELECTRON_VERSION")
fi

ZENBU_LOCAL_CORE="$CORE_DIR" \
  node "$CREATE_DIR/dist/index.mjs" "${ARGS[@]}"

blue "[4/6] static assertions"
fail=0
assert "bundle exists at $DEST_APP" test -d "$DEST_APP" || fail=1
assert "MacOS executable exists" test -x "$DEST_APP/Contents/MacOS/$NAME" || fail=1
assert "app/launcher.mjs present" test -f "$DEST_APP/Contents/Resources/app/launcher.mjs" || fail=1
assert "app/app-config.json present" test -f "$DEST_APP/Contents/Resources/app/app-config.json" || fail=1
assert "app/host.json present" test -f "$DEST_APP/Contents/Resources/app/host.json" || fail=1
assert "icon.icns present" test -f "$DEST_APP/Contents/Resources/icon.icns" || fail=1
assert "appsDir exists" test -d "$APPS_DIR" || fail=1
assert ".git/HEAD exists in appsDir" test -f "$APPS_DIR/.git/HEAD" || fail=1
assert "node_modules/@zenbujs/core/dist/setup-gate.mjs present" \
  test -f "$APPS_DIR/node_modules/@zenbujs/core/dist/setup-gate.mjs" || fail=1
assert "deps-sig file present" test -f "$APPS_DIR/.zenbu/deps-sig" || fail=1

if command -v plutil >/dev/null; then
  bid="$(plutil -extract CFBundleIdentifier raw "$DEST_APP/Contents/Info.plist" 2>/dev/null || echo "")"
  assert "CFBundleIdentifier == dev.zenbu.${SLUG}" test "$bid" = "dev.zenbu.${SLUG}" || fail=1
  cfn="$(plutil -extract CFBundleName raw "$DEST_APP/Contents/Info.plist" 2>/dev/null || echo "")"
  assert "CFBundleName == ${NAME}" test "$cfn" = "${NAME}" || fail=1
fi

if command -v codesign >/dev/null; then
  if codesign --verify --deep --strict "$DEST_APP" 2>/dev/null; then
    green "  ok: codesign --verify --deep --strict"
  else
    red "  FAIL: codesign --verify --deep --strict"
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  dump_logs_on_fail
  red "static assertions failed"
  exit 1
fi

blue "[5/6] launch with auto-quit (timeout=${LAUNCH_TIMEOUT}s, auto-quit=${AUTO_QUIT_MS}ms)"
launch_log="$(mktemp -t cza-launch.XXXXXX)"
launch_status=0
(
  ZENBU_AUTO_QUIT_AFTER_READY_MS="$AUTO_QUIT_MS" \
    "$DEST_APP/Contents/MacOS/$NAME" \
    >"$launch_log" 2>&1 &
  child_pid=$!
  (
    sleep "$LAUNCH_TIMEOUT"
    if kill -0 "$child_pid" 2>/dev/null; then
      echo "[test] timeout: killing pid=$child_pid" >>"$launch_log"
      kill -9 "$child_pid" 2>/dev/null || true
      pkill -9 -f "${NAME}.app" 2>/dev/null || true
    fi
  ) &
  watcher_pid=$!
  wait "$child_pid" 2>/dev/null
  child_status=$?
  kill "$watcher_pid" 2>/dev/null || true
  exit "$child_status"
) || launch_status=$?

if [[ "$launch_status" -eq 137 || "$launch_status" -eq 143 ]]; then
  red "  launch killed (timeout after ${LAUNCH_TIMEOUT}s, exit=$launch_status)"
  red "==== launch log tail ===="
  tail -100 "$launch_log"
  dump_logs_on_fail
  exit 1
elif [[ "$launch_status" -ne 0 ]]; then
  red "  launch exited with status $launch_status"
  red "==== launch log tail ===="
  tail -100 "$launch_log"
  dump_logs_on_fail
  exit 1
else
  green "  ok: launched + quit cleanly"
  blue "  launch log tail:"
  tail -10 "$launch_log" | sed 's/^/    /'
fi

blue "[6/6] all checks passed"
green "PASS: $NAME"
