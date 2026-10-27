#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Keep the content-hash-bound adversarial review with the repo so it survives
# across machines and CI runners.
SWAMP_EXTENSION_REVIEW_DIR="$PWD/.reviews" \
    swamp extension push extensions/models/linkdrop/manifest.yaml "$@"
