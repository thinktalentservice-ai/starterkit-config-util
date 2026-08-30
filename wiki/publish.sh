#!/usr/bin/env bash
# Publish wiki/*.md to the GitHub wiki.
#
# PREREQUISITE (one time, manual): GitHub does not create the .wiki.git repo
# until the first page is saved through the web UI. Go to
#   https://github.com/thinktalentservice-ai/starterkit-config-util/wiki
# click "Create the first page", save anything. Then run this script — it
# overwrites that placeholder.
set -euo pipefail

REMOTE="git@github.com:thinktalentservice-ai/starterkit-config-util.wiki.git"
SRC="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"

git clone "$REMOTE" "$TMP"
cp "$SRC"/*.md "$TMP"/
cd "$TMP"
git add -A
git diff --cached --quiet && { echo "wiki already up to date"; exit 0; }
git commit -m "docs: developer wiki (overview, API, architecture, migration, troubleshooting)"
git push origin HEAD
echo "published → https://github.com/thinktalentservice-ai/starterkit-config-util/wiki"
