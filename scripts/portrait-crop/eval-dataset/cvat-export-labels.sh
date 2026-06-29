#!/usr/bin/env bash
# Export CORRECTED CVAT annotations back into eval-dataset ground-truth labels.
# For each clip id (args, or every task if none): resolve task id, export
# "CVAT for video 1.1", extract annotations.xml -> cvat-exports/<id>.xml, then
# normalize -> labels/<id>.json via cvat-to-labels.ts (--dense if hero in manifest).
#
# Auth via env: CVAT_AUTH=user:pass [CVAT_HOST=http://localhost] [CVAT_PORT=8080]
# Usage:
#   CVAT_AUTH=automation:*** ./cvat-export-labels.sh                  # all tasks
#   CVAT_AUTH=automation:*** ./cvat-export-labels.sh veo_20260502_goal_01
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PC="$(cd "$HERE/.." && pwd)"
HOST="${CVAT_HOST:-http://localhost}"; PORT="${CVAT_PORT:-8080}"
: "${CVAT_AUTH:?set CVAT_AUTH=user:pass}"
cli() { cvat-cli --server-host "$HOST" --server-port "$PORT" --auth "$CVAT_AUTH" "$@" \
          2>&1 | grep -viE "WARNING: (Failed to connect|This fallback)"; }

tasks_json="$(cli task ls --json 2>/dev/null)"
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  ids=( $(printf '%s' "$tasks_json" | jq -r '.[].name') )
fi
mkdir -p "$HERE/cvat-exports" "$HERE/labels"
ok=0
for id in "${ids[@]}"; do
  tid="$(printf '%s' "$tasks_json" | jq -r --arg n "$id" '.[] | select(.name==$n) | .id' | head -1)"
  if [ -z "$tid" ] || [ "$tid" = "null" ]; then echo "skip $id (no task)"; continue; fi
  zip="/tmp/cvat_export_${id}.zip"; tmpd="/tmp/cvat_export_${id}"
  echo "exporting task $tid ($id)..."
  cli task export-dataset "$tid" "$zip" --format "CVAT for video 1.1" --completion_verification_period 3 >/dev/null
  rm -rf "$tmpd"; mkdir -p "$tmpd"; unzip -o -q "$zip" -d "$tmpd"
  src="$(find "$tmpd" -name annotations.xml | head -1)"
  [ -n "$src" ] || { echo "  no annotations.xml for $id"; continue; }
  cp "$src" "$HERE/cvat-exports/$id.xml"
  dense=""
  jq -e --arg id "$id" '.clips[] | select(.id==$id and .hero==true)' "$HERE/manifest.json" >/dev/null 2>&1 && dense="--dense"
  ( cd "$PC" && npx tsx eval-dataset/cvat-to-labels.ts \
      --cvat "$HERE/cvat-exports/$id.xml" --video "$HERE/clips/$id.mp4" \
      --clip-id "$id" --out "$HERE/labels/$id.json" $dense )
  ok=$((ok+1))
done
echo "=== exported $ok clip(s) -> labels/. Next: set frozen_holdout, re-pin, compare-to-pin. ==="
