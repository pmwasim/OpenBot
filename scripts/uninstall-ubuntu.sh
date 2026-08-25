#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${OPENBOT_INSTALL_DIR:-$HOME/.local/share/openbot}"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/openbot.desktop"

if [[ -d "$INSTALL_DIR" ]]; then
  mv "$INSTALL_DIR" "${INSTALL_DIR}.removed.$(date +%Y%m%d%H%M%S)"
  printf 'OpenBot files moved aside beside %s\n' "$INSTALL_DIR"
fi
if [[ -f "$DESKTOP_FILE" ]]; then
  mv "$DESKTOP_FILE" "${DESKTOP_FILE}.removed.$(date +%Y%m%d%H%M%S)"
  printf 'Desktop launcher moved aside beside %s\n' "$DESKTOP_FILE"
fi
