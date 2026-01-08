#!/usr/bin/env bash
set -euo pipefail

# Usage: ./run_token_server.sh
# Run this script from the examples/realtime-next/server directory or repository root.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# Activate venv if present
if [ -f "$ROOT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.venv/bin/activate"
fi

# Change into the server script directory so that module imports work correctly
pushd "$SCRIPT_DIR" > /dev/null
uvicorn token_server:app --host 0.0.0.0 --port 8000 --reload
popd > /dev/null
