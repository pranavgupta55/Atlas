#!/usr/bin/env bash
# Atlas launcher. Ensures Scribe is up, boots Atlas, opens browser.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY not set. export it before running Atlas." >&2
  exit 1
fi

# Optional: verify Scribe is reachable
SCRIBE_URL="${SCRIBE_URL:-http://localhost:8765}"
if ! curl -s -m 2 "${SCRIBE_URL}/api/status" >/dev/null 2>&1; then
  echo "⚠️  Scribe not reachable at ${SCRIBE_URL}. Start it in the Scribe dir: bash serve.sh" >&2
fi

# venv setup on first run
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
source .venv/bin/activate

mkdir -p data
python3 -c "from context_store import ContextStore; from pathlib import Path; ContextStore(Path('data/context.jsonl')).save()"

echo "🌍 Atlas → http://localhost:8766"
open "http://localhost:8766" || true

exec python3 server.py
