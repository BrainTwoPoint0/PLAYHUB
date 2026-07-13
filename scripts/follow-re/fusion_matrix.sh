#!/bin/zsh
# One-shot follow-quality matrix on the held-out clip: label-0-only vs +YOLO fusion,
# centroid vs antiteleport. Run after precompute_yolo_ball.py has written the JSON.
#   ./fusion_matrix.sh [clip] [yolo_conf]
set -e
cd "$(dirname "$0")"
CLIP=${1:-424e420a}
YC=${2:-0.35}
echo "=== follow matrix on $CLIP (YOLO_CONF=$YC) ==="
for M in centroid antiteleport; do
  echo "--- $M / label-0 only ---"
  CLIP=$CLIP MODE=$M python3 ball_follow.py 2>&1 | grep -viE warning | grep "pan corr"
  echo "--- $M / +YOLO fused ---"
  CLIP=$CLIP MODE=$M FUSE_YOLO=1 YOLO_CONF=$YC python3 ball_follow.py 2>&1 | grep -viE warning | grep -E "pan corr|fused"
done
