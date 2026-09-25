#!/bin/sh
# Run a Python tool with the repo's .venv (huggingface_hub + mutagen) when it
# exists, else the system python3. Used by the npm scripts.
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$root/.venv/bin/python" ]; then
  exec "$root/.venv/bin/python" "$@"
fi
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$@"
fi
echo "python3 not found. Install Python 3.10+ (and: python3 -m venv .venv && .venv/bin/pip install --require-hashes --only-binary=:all: -r tools/requirements.lock)" >&2
exit 127
