#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${OPENBOT_INSTALL_DIR:-$HOME/.local/share/openbot}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

mkdir -p "$INSTALL_DIR" "$DESKTOP_DIR"
cp -R "$SOURCE_DIR"/. "$INSTALL_DIR"/
sed "s|%k|$INSTALL_DIR|g" "$SOURCE_DIR/desktop/openbot.desktop" > "$DESKTOP_DIR/openbot.desktop"
chmod +x "$INSTALL_DIR/desktop/openbot.mjs" "$INSTALL_DIR/scripts/install-ubuntu.sh"
printf 'OpenBot installed at %s\n' "$INSTALL_DIR"
printf 'Launch from your applications menu or run: node %s/desktop/openbot.mjs\n' "$INSTALL_DIR"
