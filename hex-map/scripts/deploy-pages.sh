#!/usr/bin/env bash
# Build the hex-map and push it to the `gh-pages` branch as an orphan commit.
# Run from the project root or from hex-map/.
#
# Why a manual script instead of `gh-pages` (npm) or a GH Actions workflow?
#   - The npm `gh-pages` package has been flaky about leaving stale files
#     in the published branch when used with --no-history.
#   - This script does an orphan-worktree commit, so the branch contains
#     ONLY the freshly built dist/ contents at the root — no leftovers.
#
# Requires:
#   - The remote `origin` points at the GitHub repo (SSH or HTTPS).
#   - You can push to the repo (e.g. SSH key registered on GitHub).
#
# Usage:
#   bash hex-map/scripts/deploy-pages.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HEX_MAP_DIR="$REPO_ROOT/hex-map"
DIST_DIR="$HEX_MAP_DIR/dist"

# GitHub project sites live at https://<user>.github.io/<repo>/, so Vite
# needs that subpath as `base` when building.
REPO_NAME="$(basename -s .git "$(git -C "$REPO_ROOT" remote get-url origin)")"
BASE="/${REPO_NAME}/"

echo "▶ Building hex-map with VITE_BASE=$BASE"
( cd "$HEX_MAP_DIR" && VITE_BASE="$BASE" pnpm build )

if [[ ! -f "$DIST_DIR/index.html" ]]; then
   echo "✗ Build did not produce $DIST_DIR/index.html" >&2
   exit 1
fi

# Ensure GitHub Pages doesn't try to run Jekyll on the build output.
touch "$DIST_DIR/.nojekyll"

WORKTREE="$(mktemp -d -t cividle-ghpages.XXXXXX)"
TMP_BRANCH="gh-pages-publish-$$"

cleanup() {
   git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
   git -C "$REPO_ROOT" branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ Preparing orphan worktree at $WORKTREE"
git -C "$REPO_ROOT" worktree add --detach --no-checkout "$WORKTREE" HEAD >/dev/null
(
   cd "$WORKTREE"
   git checkout --orphan "$TMP_BRANCH" >/dev/null
   git rm -rf . >/dev/null 2>&1 || true
   find . -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
   cp -R "$DIST_DIR/." .
   git add -A
   git -c commit.gpgsign=false \
       -c user.name="$(git config user.name)" \
       -c user.email="$(git config user.email)" \
       commit -m "Deploy hex-map $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
)

echo "▶ Force-pushing to origin/gh-pages"
git -C "$REPO_ROOT" push --force origin "$TMP_BRANCH:gh-pages"

REPO_OWNER="$(git -C "$REPO_ROOT" remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#' | tr '[:upper:]' '[:lower:]')"
echo "✓ Deployed. Site: https://${REPO_OWNER}.github.io/${REPO_NAME}/"
echo "  (May take ~30s on first push for GitHub Pages to update.)"
