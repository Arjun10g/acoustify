#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -x .venv/bin/python ]]; then
  exec "$ROOT/install_macos.command"
fi

.venv/bin/python -m pip install --upgrade --pre "yt-dlp[default]"
echo
echo "Extractor engine updated."
read -r "?Press Return to close…"
