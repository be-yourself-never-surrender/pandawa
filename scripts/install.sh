#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PANDAWA_REPO:-https://github.com/be-yourself-never-surrender/pandawa.git}"
INSTALL_DIR="${PANDAWA_DIR:-$HOME/.pandawa}"
PORT="${PANDAWA_PORT:-7777}"

echo ""
echo "  ⚡ Installing Pandawa — Visual Agentic Team & Layered Brain Platform"
echo "  --------------------------------------------------------------------"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required. Please install git first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 22+ (recommended v24) is required. Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js v22+ is required (found $(node -v)). Please upgrade to Node.js 24 LTS."
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating existing Pandawa installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "→ Cloning Pandawa into $INSTALL_DIR..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "→ Installing dependencies..."
npm install --no-audit --no-fund
npm --prefix web install --no-audit --no-fund

echo "→ Building backend & Web Studio..."
npm run build

# Create global symlink if /usr/local/bin is writable
if [ -w /usr/local/bin ]; then
  chmod +x "$INSTALL_DIR/dist/server/cli.js"
  ln -sf "$INSTALL_DIR/dist/server/cli.js" /usr/local/bin/pandawa
  echo "→ Linked CLI command: pandawa"
fi

echo ""
echo "  ✅ Pandawa installed successfully!"
echo ""
echo "  Start Web Studio : cd $INSTALL_DIR && PANDAWA_PORT=$PORT npm start"
echo "  Open Browser     : http://localhost:$PORT (default password: 11111111)"
echo "  Interactive CLI  : pandawa chat | pandawa status | pandawa doctor"
echo ""
