#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

docker build -t linkdrop-builder "$ROOT"
mkdir -p "$ROOT/.gradle-cache"

docker run --rm \
    -v "$ROOT":/src \
    -v "$ROOT/.gradle-cache":/home/gradle/.gradle \
    -w /src \
    linkdrop-builder \
    gradle --no-daemon testDebugUnitTest
