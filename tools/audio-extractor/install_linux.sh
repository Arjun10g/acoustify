#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "Podcast Audio Extractor — Linux setup"

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y python3 python3-venv python3-tk ffmpeg curl unzip
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y python3 python3-tkinter ffmpeg curl unzip
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -S --needed python tk ffmpeg curl unzip
else
  echo "Install Python 3.10+, Tkinter, FFmpeg/FFprobe, curl, and unzip with your package manager."
fi

if ! command -v deno >/dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | sh
  export PATH="$HOME/.deno/bin:$PATH"
fi

python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --upgrade --pre "yt-dlp[default]"
chmod +x run_linux.sh update_linux.sh install_linux.sh
exec .venv/bin/python app.py
