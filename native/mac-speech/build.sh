#!/usr/bin/env bash
# Builds codewrench-speech. macOS only (needs swiftc from the Xcode command line tools).
# Usage: build.sh [--arch arm64|x64|universal] [--output <path>]
# Default output: native/mac-speech/build/codewrench-speech, where a dev run looks for it.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[mac-speech] skipped: the Apple speech helper can only be built on macOS." >&2
  exit 0
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="$(uname -m)"
[[ "$arch" == "x86_64" ]] && arch="x64"
output="$here/build/codewrench-speech"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$output")"
compile() { # <swift target arch> <output>
  # The embedded Info.plist carries the usage descriptions macOS asks for when it prompts.
  swiftc -O -swift-version 5 -target "$1-apple-macos12.0" "$here/main.swift" -o "$2" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist"
}

case "$arch" in
  arm64) compile arm64 "$output" ;;
  x64) compile x86_64 "$output" ;;
  universal)
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    compile arm64 "$tmp/arm64"
    compile x86_64 "$tmp/x64"
    lipo -create "$tmp/arm64" "$tmp/x64" -output "$output"
    ;;
  *) echo "unknown arch: $arch" >&2; exit 2 ;;
esac
chmod 755 "$output"
echo "[mac-speech] built $output"
