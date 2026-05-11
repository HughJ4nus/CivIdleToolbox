#!/usr/bin/env bash
# Build the CivIdle Toolbox (landing page + each tool) and push the combined
# output to the `gh-pages` branch as an orphan commit. Mirrors what the
# .github/workflows/deploy-pages.yml workflow does, for manual deploys.
#
# Layout produced under dist/:
#   dist/index.html       — landing page with the tool dropdown
#   dist/hex-map/         — built hex-map (Vite base = /<repo>/hex-map/)
#
# Why orphan commits instead of `gh-pages` (npm)?
#   The npm package has been flaky about leaving stale files in the published
#   branch when used with --no-history. An orphan-worktree commit keeps the
#   branch as exactly the freshly built dist/ — no leftovers.
#
# Requires:
#   - The remote `origin` points at the GitHub repo (SSH or HTTPS).
#   - You can push to the repo (e.g. SSH key registered on GitHub).
#
# Usage (from any directory inside the repo):
#   bash scripts/deploy-pages.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HEX_MAP_DIR="$REPO_ROOT/hex-map"
LANDING_DIR="$REPO_ROOT/landing"
DIST_DIR="$REPO_ROOT/dist"

REPO_NAME="$(basename -s .git "$(git -C "$REPO_ROOT" remote get-url origin)")"

echo "▶ Building hex-map (base = /${REPO_NAME}/hex-map/)"
( cd "$HEX_MAP_DIR" && VITE_BASE="/${REPO_NAME}/hex-map/" pnpm build )

if [[ ! -f "$HEX_MAP_DIR/dist/index.html" ]]; then
   echo "✗ hex-map build did not produce dist/index.html" >&2
   exit 1
fi

echo "▶ Assembling combined dist/"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/hex-map"
cp -R "$HEX_MAP_DIR/dist/." "$DIST_DIR/hex-map/"
cp -R "$LANDING_DIR/." "$DIST_DIR/"

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
       commit -m "Deploy CivIdle Toolbox $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
)

echo "▶ Force-pushing to origin/gh-pages"
git -C "$REPO_ROOT" push --force origin "$TMP_BRANCH:gh-pages"

REPO_OWNER="$(git -C "$REPO_ROOT" remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#' | tr '[:upper:]' '[:lower:]')"
echo "✓ Deployed. Site: https://${REPO_OWNER}.github.io/${REPO_NAME}/"
echo "  (May take ~30s on first push for GitHub Pages to update.)"
