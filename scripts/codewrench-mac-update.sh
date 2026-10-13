#!/usr/bin/env bash
# Build, verify and install the CodeWrench Mac app in one step.
#
#   scripts/codewrench-mac-update.sh            build, verify, then install
#   scripts/codewrench-mac-update.sh --build    build and verify only
#   scripts/codewrench-mac-update.sh --report   only tell the server which commit this Mac runs
#
# After installing, the commit is written to the server (CODEWRENCH_SERVER_SSH, default
# candid-server; empty to skip). scripts/codewrench-server-update.sh reads it there and will not
# restart the server onto a commit this Mac app does not have yet.
#
# The installed app is quit to be replaced, so the install step refuses to run while a local agent
# is working unless --force is given. The previous app is kept as a rollback and the database is
# snapshotted first. Settings come from the environment; the defaults match the owner's Mac.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${CODEWRENCH_APP_NAME:-CodeWrench}"
BUNDLE_ID="${CODEWRENCH_BUNDLE_ID:-com.savagedigital.workbench.preview}"
INSTALL_DIR="${CODEWRENCH_INSTALL_DIR:-$HOME/Applications}"
DATA_DIR="${CODEWRENCH_DATA_DIR:-$HOME/.workbench-preview/userdata}"
OUT_DIR="${CODEWRENCH_OUT_DIR:-$HOME/Documents/Codex/2026-10-01/okay-i-want-to-make-my/outputs/installers}"
ROLLBACK_DIR="${CODEWRENCH_ROLLBACK_DIR:-$HOME/Documents/Codex/2026-10-01/okay-i-want-to-make-my/work}"
BACKUP_DIR="${CODEWRENCH_BACKUP_DIR:-$HOME/Library/Application Support/Workbench Backups}"
SIGN_IDENTITY="${CODEWRENCH_SIGN_IDENTITY:-}"
NODE_BIN_DIR="${CODEWRENCH_NODE_BIN_DIR:-}"
BASE_VERSION="${CODEWRENCH_BASE_VERSION:-0.0.45-preview}"
SERVER_SSH="${CODEWRENCH_SERVER_SSH-candid-server}"
SERVER_USER="${CODEWRENCH_SERVER_USER:-agents}"
SERVER_MAC_MARK="${CODEWRENCH_SERVER_MAC_MARK:-/home/$SERVER_USER/codewrench-backups/mac-commit}"

build_only=false
force=false
report_only=false
for arg in "$@"; do
  case "$arg" in
    --build) build_only=true ;;
    --force) force=true ;;
    --report) report_only=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The commit an installed app was built from, read from package.json inside its app.asar.
app_commit() {
  python3 -I - "$1/Contents/Resources/app.asar" <<'PY'
import json, struct, sys
with open(sys.argv[1], "rb") as f:
    f.read(4)
    header_size = struct.unpack("<I", f.read(4))[0]
    f.read(4)
    header = json.loads(f.read(struct.unpack("<I", f.read(4))[0]))
    entry = header["files"]["package.json"]
    f.seek(8 + header_size + int(entry["offset"]))
    print(json.loads(f.read(entry["size"]))["t3codeCommitHash"])
PY
}

# Write the commit to the server's mark as the service user. A failure only warns: the app is
# already installed, and the server update will refuse until the mark is right.
report_to_server() {
  local commit="$1"
  [ -n "$SERVER_SSH" ] || return 0
  if ssh -o ConnectTimeout=10 -o BatchMode=yes "$SERVER_SSH" \
    "sudo -n -u $SERVER_USER tee $SERVER_MAC_MARK >/dev/null" <<<"$commit"; then
    echo "Told $SERVER_SSH this Mac runs $commit"
  else
    echo "Could not tell $SERVER_SSH which commit this Mac runs; run this again with --report." >&2
  fi
}

installed="$INSTALL_DIR/$APP_NAME.app"
if $report_only; then
  [ -d "$installed" ] || { echo "No app installed at $installed" >&2; exit 1; }
  report_to_server "$(app_commit "$installed")"
  exit 0
fi
[ -n "$SIGN_IDENTITY" ] || { echo "Set CODEWRENCH_SIGN_IDENTITY to the Developer ID identity" >&2; exit 2; }

installed_version=""
if [ -d "$installed" ]; then
  installed_version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$installed/Contents/Info.plist")"
fi
# Versions look like 0.0.45-preview.20261004.43; the last number only ever goes up.
last_build="${installed_version##*.}"
[[ "$last_build" =~ ^[0-9]+$ ]] || last_build=0
build_number="${CODEWRENCH_BUILD_NUMBER:-$((last_build + 1))}"
version="$BASE_VERSION.$(date +%Y%m%d).$build_number"

# A build that was verified but not installed (an agent was running) is reused by the next run
# instead of being built again, as long as it came from this same commit with nothing uncommitted.
head_commit="$(git -C "$REPO" rev-parse HEAD)"
dirty="$(git -C "$REPO" status --porcelain)"
built_mark="$OUT_DIR/$APP_NAME-$version-arm64.commit"
if [ -z "${CODEWRENCH_UPDATE_FEED_URL:-}" ] && [ -z "$dirty" ] && [ -f "$OUT_DIR/$APP_NAME-$version-arm64.zip" ] && [ "$(cat "$built_mark" 2>/dev/null)" = "$head_commit" ]; then
  echo "Reusing the $version build already made from $(git -C "$REPO" log --oneline -1)"
else
  echo "Building $APP_NAME $version from $(git -C "$REPO" log --oneline -1)"
  [ -z "$dirty" ] || echo "Note: the checkout has uncommitted changes; they are part of this build."
  mkdir -p "$OUT_DIR"
  rm -f "$built_mark"
  (
    cd "$REPO"
    [ -z "$NODE_BIN_DIR" ] || PATH="$NODE_BIN_DIR:$PATH"
    PATH="$REPO/node_modules/.bin:$PATH" WORKBENCH_PREVIEW_BUILD=1 RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.95.0}" \
      CODEWRENCH_SIGN_IDENTITY="$SIGN_IDENTITY" \
      node scripts/build-desktop-artifact.ts --platform mac --arch arm64 --build-version "$version" \
      --output-dir "$OUT_DIR" --keep-stage >"$OUT_DIR/build-$build_number.log" 2>&1
  ) || { echo "Build failed. See $OUT_DIR/build-$build_number.log" >&2; exit 1; }
  [ -n "$dirty" ] || echo "$head_commit" >"$built_mark"
fi

# Verify a copy outside ~/Documents, which adds attributes that fail signature checks.
stage="$(mktemp -d "${TMPDIR:-/tmp}/codewrench-update.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
ditto -x -k "$OUT_DIR/$APP_NAME-$version-arm64.zip" "$stage"
built="$stage/$APP_NAME.app"
built_version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$built/Contents/Info.plist")"
[ "$built_version" = "$version" ] || { echo "Built version is $built_version, expected $version" >&2; exit 1; }
codesign --verify --deep --strict "$built"
actual_bundle="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$built/Contents/Info.plist")"
[ "$actual_bundle" = "$BUNDLE_ID" ] || { echo "Unexpected built bundle identity" >&2; exit 1; }
if [ -n "${CODEWRENCH_UPDATE_FEED_URL:-}" ]; then
  # A feed must never bootstrap from ad-hoc or another team's signed app.
  expected_team="${SIGN_IDENTITY##*(}"
  expected_team="${expected_team%)}"
  actual_team="$(codesign -dv "$built" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [ "$actual_team" = "$expected_team" ] || { echo "Unexpected signing team" >&2; exit 1; }
  [ -f "$built/Contents/Resources/app-update.yml" ] || { echo "Update feed missing from app" >&2; exit 1; }
  [ -f "$OUT_DIR/latest-mac.yml" ] || { echo "Update manifest missing from output" >&2; exit 1; }
fi
echo "Built and verified $version (signed by $(codesign -dv "$built" 2>&1 | sed -n 's/^TeamIdentifier=//p'))"
if $build_only; then
  echo "Not installing (--build). The build is in $OUT_DIR"
  exit 0
fi

# Installing quits the app, which ends any run a local agent has in progress.
busy="$(ps -axo command | grep -F "$(dirname "$DATA_DIR")" | grep -E "/(claude|codex|grok|cursor-agent|opencode)( |$)" | grep -vc grep || true)"
if [ "$busy" != 0 ] && ! $force; then
  echo "$busy local agent process(es) are running, so nothing was installed." >&2
  echo "Run again with --force to install now (this interrupts them; the build is kept, not redone)," >&2
  echo "or run again without it once they have finished." >&2
  exit 3
fi

mkdir -p "$BACKUP_DIR" "$ROLLBACK_DIR"
snapshot="$BACKUP_DIR/pre-$build_number-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$snapshot"
if [ -f "$DATA_DIR/statev2.sqlite" ]; then
  sqlite3 "file:$DATA_DIR/statev2.sqlite?mode=ro" "VACUUM INTO '$snapshot/statev2.sqlite'"
  [ "$(sqlite3 "$snapshot/statev2.sqlite" 'pragma integrity_check')" = ok ] || { echo "Backup failed its integrity check" >&2; exit 1; }
fi
[ ! -f "$DATA_DIR/settings.json" ] || cp -p "$DATA_DIR/settings.json" "$snapshot/"

osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  pgrep -f "$installed/Contents/MacOS" >/dev/null || break
  sleep 1
done
if pgrep -f "$installed/Contents/MacOS" >/dev/null; then
  echo "$APP_NAME did not quit. Nothing was changed." >&2
  exit 1
fi

if [ -d "$installed" ]; then
  rollback="$ROLLBACK_DIR/$APP_NAME-${installed_version##*.}-replaced.app"
  rm -rf "$rollback"
  mv "$installed" "$rollback"
  echo "Previous app kept at $rollback"
fi
ditto "$built" "$installed"
codesign --verify --deep --strict "$installed"
open "$installed"
echo "Installed and launched $version. Data backup: $snapshot"
report_to_server "$(app_commit "$installed")"
