#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ ! -x .venv/bin/python ]]; then
  exec "$ROOT/install_linux.sh"
fi
.venv/bin/python -m pip install --upgrade --pre "yt-dlp[default]"
echo "Extractor engine updated."
