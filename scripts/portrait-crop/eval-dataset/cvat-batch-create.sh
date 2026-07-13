#!/usr/bin/env bash
# Batch-create CVAT tasks for every manifest clip that has a detector
# pre-annotation, uploading the video + importing the boxes in one shot.
# The only manual step left is correcting the boxes in the CVAT UI.
#
# Auth via env (never hardcode creds in the repo):
#   CVAT_AUTH=user:pass  [CVAT_HOST=http://localhost] [CVAT_PORT=8080]
# Usage:
#   CVAT_AUTH=automation:*** ./cvat-batch-create.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${CVAT_HOST:-http://localhost}"; PORT="${CVAT_PORT:-8080}"
: "${CVAT_AUTH:?set CVAT_AUTH=user:pass}"
# CLIPS_DIR overrides where the .mp4s live (XMLs always in cvat-imports/). For the
# B-ball corpus: CLIPS_DIR=../mining/corpus ./cvat-batch-create.sh
CLIPS_DIR="${CLIPS_DIR:-$HERE/clips}"

cli() { cvat-cli --server-host "$HOST" --server-port "$PORT" --auth "$CVAT_AUTH" "$@" \
          2>&1 | grep -viE "WARNING: (Failed to connect|This fallback)"; }

# Existing task NAMES (default `task ls` prints only IDs — must use --json).
existing="$(cli task ls --json 2>/dev/null | jq -r '.[].name' 2>/dev/null || true)"
created=0; skipped=0
for mp4 in "$CLIPS_DIR"/*.mp4; do
  id="$(basename "$mp4" .mp4)"
  xml="$HERE/cvat-imports/$id.xml"
  if [ ! -f "$xml" ]; then echo "skip $id (no pre-annotation)"; skipped=$((skipped+1)); continue; fi
  if printf '%s\n' "$existing" | grep -qxF "$id"; then echo "skip $id (task already exists)"; skipped=$((skipped+1)); continue; fi
  echo "creating $id ..."
  cli task create "$id" local "$mp4" \
    --labels '[{"name":"ball"}]' \
    --annotation_path "$xml" --annotation_format "CVAT 1.1" \
    --completion_verification_period 3 | grep -E "Created task ID|operation status: finished|uploaded" || echo "  (check $id)"
  created=$((created+1))
done
echo "=== done: created=$created skipped=$skipped — open $HOST:$PORT → Tasks ==="
