#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
APK="${1:-dist/linkdrop.apk}"

if ! command -v adb >/dev/null 2>&1; then
    echo "adb not found. Install Android platform-tools, or copy the APK to the device and tap it." >&2
    exit 1
fi

if [ ! -f "$APK" ]; then
    echo "APK not found: $APK" >&2
    echo "Build it first with ./scripts/build.sh" >&2
    exit 1
fi

adb install -r "$APK"
