#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LINKDROP_URL="${LINKDROP_URL:-https://linkdrop.fi.gy/hooks/linkdrop}"

docker build -t linkdrop-builder "$ROOT"

if [ ! -f keystore/linkdrop.jks ] || [ ! -f keystore.properties ]; then
    "$ROOT/scripts/make-keystore.sh"
fi

mkdir -p "$ROOT/.gradle-cache" "$ROOT/dist"

docker run --rm \
    -v "$ROOT":/src \
    -v "$ROOT/.gradle-cache":/home/gradle/.gradle \
    -w /src \
    linkdrop-builder \
    gradle --no-daemon assembleRelease -PlinkdropUrl="$LINKDROP_URL"

APK="$ROOT/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
    echo "Release APK not found at $APK" >&2
    exit 1
fi

cp "$APK" "$ROOT/dist/linkdrop.apk"
echo
echo "APK: $ROOT/dist/linkdrop.apk"
echo "Install: adb install -r $ROOT/dist/linkdrop.apk"
