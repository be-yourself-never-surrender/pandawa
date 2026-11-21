#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[Pandawa Python Worker] Setting up isolated venv in $DIR/.venv ..."
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --upgrade pip
"$DIR/.venv/bin/pip" install -r "$DIR/requirements.txt"
if [ "${SKIP_PLAYWRIGHT_BROWSER:-0}" != "1" ]; then
  echo "[Pandawa Python Worker] Installing headless Chromium for Playwright..."
  "$DIR/.venv/bin/playwright" install chromium
fi
echo "[Pandawa Python Worker] Done!"
