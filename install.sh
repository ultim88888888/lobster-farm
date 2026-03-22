#!/bin/bash
set -e

echo "Installing LobsterFarm..."

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is required. Install it first: https://nodejs.org"
  exit 1
fi

if ! command -v pnpm &> /dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

# Clone or update
INSTALL_DIR="$HOME/.lobsterfarm/src"
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating LobsterFarm..."
  cd "$INSTALL_DIR"
  git pull
else
  echo "Cloning LobsterFarm..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone https://github.com/ultim88888888/lobster-farm.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Build
echo "Building..."
pnpm install && pnpm build

# Link CLI globally so `lf` command works from anywhere
echo "Linking CLI..."
cd packages/cli
npm link 2>/dev/null || sudo npm link 2>/dev/null || true
cd "$INSTALL_DIR"

# Run setup wizard
echo ""
lf init 2>/dev/null || node packages/cli/dist/index.js init
