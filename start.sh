#!/usr/bin/env sh
# EasyRead launcher for macOS / Linux. First run creates .venv and installs; later runs just start.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Setting up EasyRead (first run only)..."
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -e .
  else
    python3 -m venv .venv && .venv/bin/python -m pip install -q -e .
  fi
fi
exec .venv/bin/python -m easyread serve --open --exit-on-close
