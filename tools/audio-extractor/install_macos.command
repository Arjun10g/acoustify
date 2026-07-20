#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Podcast Audio Extractor — macOS setup"
echo

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required for the one-click setup."
  echo "Install it from https://brew.sh and run this file again."
  read -r "?Press Return to close…"
  exit 1
fi

brew install python-tk ffmpeg deno

PYTHON="$(brew --prefix)/bin/python3"
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --upgrade --pre "yt-dlp[default]"

chmod +x run_macos.command update_macos.command install_macos.command

echo
echo "Setup complete. Opening the app…"
exec .venv/bin/python app.py
