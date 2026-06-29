#!/usr/bin/env bash
# Close the correction→label flywheel loop. Score every auto-cropped clip, and for
# the ones that need a human, generate a CVAT pre-annotation from the auto-track and
# create the CVAT task (video + pre-fill in one shot) — so a correction is a nudge,
# not 500 boxes from scratch. After a human corrects + exports, cvat-to-labels.ts
# stamps the result as a leak-safe label and prep_dataset.py's by-match guard keeps
# the gate trustworthy. This is the only manual step in the whole loop.
#
#   ./stage-review.sh --dry-run             # just show the review queue (no CVAT)
#   CVAT_AUTH=user:pass ./stage-review.sh   # stage pre-annotations + create tasks
#
# Env: CVAT_AUTH=user:pass  [CVAT_HOST=http://localhost] [CVAT_PORT=8080]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

# 1. Score → the clips a human should look at (flagged, OR un-assessable so a human
#    look is the safe default rather than a silent pass).
queue="$(node "$HERE/flag-clips.mjs" --json | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const c of r) if (c.needsReview || c.cands === false) console.log(c.clipId)
')"
if [ -z "$queue" ]; then echo "review queue empty — every clip is clean ✓"; exit 0; fi
echo "=== review queue ($(printf '%s\n' "$queue" | grep -c .) clips) ==="
printf '  %s\n' $queue

if [ "$DRY" = 1 ]; then echo "(dry-run — no pre-annotations generated, no tasks created)"; exit 0; fi

# 2. Generate a CVAT pre-annotation (the auto-track) for each queued clip.
echo "=== generating pre-annotations (auto-track → cvat-imports/) ==="
staged=0
while read -r id; do
  [ -z "$id" ] && continue
  raw="$HERE/clips/${id}_raw.json"
  if [ ! -f "$raw" ]; then echo "  skip $id (no _raw.json — run detect_ball.py first)"; continue; fi
  if npx tsx "$HERE/bootstrap-labels.ts" --video "$HERE/clips/${id}.mp4" --clip-id "$id" \
       --raw "$raw" --out "$HERE/cvat-imports/${id}.xml" 2>&1 | tail -1; then
    staged=$((staged + 1))
  fi
done <<< "$queue"
echo "staged $staged pre-annotation(s)"

# 3. Create the CVAT tasks (video + pre-annotation in one shot). Idempotent:
#    cvat-batch-create.sh skips clips whose task already exists.
: "${CVAT_AUTH:?set CVAT_AUTH=user:pass to create CVAT tasks (or use --dry-run)}"
echo "=== creating CVAT tasks ==="
bash "$HERE/cvat-batch-create.sh"
echo "=== loop ready: correct the flagged clips in CVAT → export to cvat-exports/ →"
echo "    cvat-to-labels.ts stamps each as a leak-safe label. ==="
