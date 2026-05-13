#!/usr/bin/env bash
# Build every tool and assemble the combined dist/ that mirrors what gets
# deployed to GitHub Pages.
#
# Used by:
#   - `pnpm preview` (root) — local preview after assembly
#   - scripts/deploy-pages.sh — manual deploy to gh-pages
#   - .github/workflows/deploy-pages.yml uses the same steps inline
#
# By default each tool's Vite `base` is /<tool-id>/ (suits a localhost
# preview served from dist/). The deploy script overrides this with
# /<repo-name>/<tool-id>/ for GitHub project pages.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HEX_MAP_DIR="$REPO_ROOT/hex-map"
PROD_LINES_DIR="$REPO_ROOT/production-lines"
DIST_DIR="$REPO_ROOT/dist"

HEX_MAP_BASE="${HEX_MAP_BASE:-/hex-map/}"
PROD_LINES_BASE="${PROD_LINES_BASE:-/production-lines/}"

echo "▶ Building hex-map (base = $HEX_MAP_BASE)"
( cd "$HEX_MAP_DIR" && VITE_BASE="$HEX_MAP_BASE" pnpm build )

echo "▶ Building production-lines (base = $PROD_LINES_BASE)"
( cd "$PROD_LINES_DIR" && VITE_BASE="$PROD_LINES_BASE" pnpm build )

echo "▶ Copying egp-planner (single-file static tool)"
EGP_DIR="$REPO_ROOT/egp-planner"

echo "▶ Assembling combined dist/"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/hex-map" "$DIST_DIR/egp-planner" "$DIST_DIR/production-lines"
cp -R "$HEX_MAP_DIR/dist/." "$DIST_DIR/hex-map/"
cp -R "$PROD_LINES_DIR/dist/." "$DIST_DIR/production-lines/"
cp -R "$EGP_DIR/." "$DIST_DIR/egp-planner/"
# Landing page (and any other root-level static assets) goes at dist root.
cp "$REPO_ROOT/index.html" "$DIST_DIR/"
touch "$DIST_DIR/.nojekyll"
