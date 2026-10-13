#!/usr/bin/env bash
# Upload the newest CodeWrench Mac build and print a download link to send to someone.
#
#   scripts/codewrench-mac-share.sh
#
# The build goes to a GitHub repository that holds downloads only, never source. The first run
# creates that repository as PUBLIC, so anyone with the link can download the app. A copy of the
# zip is also left in ~/Downloads, which stays on this Mac (the build folder under ~/Documents can
# be moved to iCloud, where Mail and Messages cannot attach it).
set -euo pipefail

APP_NAME="${CODEWRENCH_APP_NAME:-CodeWrench}"
OUT_DIR="${CODEWRENCH_OUT_DIR:-$HOME/Documents/Codex/2026-10-01/okay-i-want-to-make-my/outputs/installers}"
RELEASES_REPO="${CODEWRENCH_RELEASES_REPO:-support318/codewrench-releases}"
ASSET_NAME="$APP_NAME-mac-arm64.zip"

command -v gh >/dev/null || {
  echo "GitHub's command line tool is needed: brew install gh && gh auth login" >&2
  exit 1
}

newest="$(ls -t "$OUT_DIR/$APP_NAME"-*-arm64.zip 2>/dev/null | head -1 || true)"
[ -n "$newest" ] || { echo "No build found in $OUT_DIR. Run scripts/codewrench-mac-update.sh first." >&2; exit 1; }
version="$(basename "$newest" -arm64.zip)"
version="${version#"$APP_NAME"-}"

# Work on a copy outside ~/Documents: reading it also fetches the file if iCloud has taken it.
stage="$(mktemp -d "${TMPDIR:-/tmp}/codewrench-share.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
cp "$newest" "$stage/$ASSET_NAME"
ditto -x -k "$stage/$ASSET_NAME" "$stage/app"
codesign --verify --deep --strict "$stage/app/$APP_NAME.app"
if spctl --assess --type execute "$stage/app/$APP_NAME.app" 2>/dev/null; then
  opens_cleanly=true
else
  opens_cleanly=false
fi

cp "$stage/$ASSET_NAME" "$HOME/Downloads/$ASSET_NAME"

if ! gh repo view "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "Creating the public downloads repository $RELEASES_REPO"
  gh repo create "$RELEASES_REPO" --public --add-readme \
    --description "Downloads for CodeWrench by Savage Digital Solutions"
fi

tag="v$version"
if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  gh release upload "$tag" "$stage/$ASSET_NAME" --repo "$RELEASES_REPO" --clobber
else
  gh release create "$tag" "$stage/$ASSET_NAME" --repo "$RELEASES_REPO" --latest \
    --title "$APP_NAME $version" \
    --notes "$APP_NAME for Mac with Apple silicon. Unzip, then drag $APP_NAME into Applications."
fi

echo
echo "Shared $APP_NAME $version. Send this link (it always points at the newest upload):"
echo "  https://github.com/$RELEASES_REPO/releases/latest/download/$ASSET_NAME"
echo "A copy is also in ~/Downloads/$ASSET_NAME"
if ! $opens_cleanly; then
  echo
  echo "Note: this build is not notarized by Apple, so the recipient's Mac will block it at first."
  echo "They open System Settings > Privacy & Security and choose Open Anyway."
fi
