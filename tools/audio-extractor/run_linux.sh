#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ ! -x .venv/bin/python ]]; then
  exec "$ROOT/install_linux.sh"
fi
exec .venv/bin/python app.py
