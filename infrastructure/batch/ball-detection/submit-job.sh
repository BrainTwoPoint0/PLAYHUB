#!/usr/bin/env bash
# Submit a ball detection job to AWS Batch.
# Must run with AWS_PROFILE=playhub.
#
# Usage: ./submit-job.sh <input-s3-key> [output-s3-key] [fps]
#
# Examples:
#   ./submit-job.sh recordings/cfa/clip.mp4
#   ./submit-job.sh recordings/cfa/clip.mp4 ball-detection/cfa/clip.json 10

set -euo pipefail

INPUT_KEY="${1:?Usage: ./submit-job.sh <input-s3-key> [output-s3-key] [fps]}"

# Default output key: ball-detection/<stem>.json
STEM="${INPUT_KEY#recordings/}"           # strip recordings/ prefix if present
STEM="${STEM%.mp4}"                        # strip .mp4 extension
OUTPUT_KEY="${2:-ball-detection/${STEM}.json}"

FPS="${3:-5}"

JOB_QUEUE="playhub-ball-detection-queue"
JOB_DEFINITION="playhub-ball-detection"
S3_BUCKET="playhub-recordings"

# Generate a unique job name from the input key
JOB_NAME="ball-detect-$(echo "$STEM" | tr '/' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | head -c 100)"

echo "=== Submit Ball Detection Job ==="
echo "Input:  s3://${S3_BUCKET}/${INPUT_KEY}"
echo "Output: s3://${S3_BUCKET}/${OUTPUT_KEY}"
echo "FPS:    ${FPS}"
echo "Job:    ${JOB_NAME}"
echo ""

JOB_ID=$(aws batch submit-job \
    --job-name "$JOB_NAME" \
    --job-queue "$JOB_QUEUE" \
    --job-definition "$JOB_DEFINITION" \
    --container-overrides "{
        \"environment\": [
            {\"name\": \"INPUT_S3_KEY\", \"value\": \"${INPUT_KEY}\"},
            {\"name\": \"OUTPUT_S3_KEY\", \"value\": \"${OUTPUT_KEY}\"},
            {\"name\": \"OUTPUT_FPS\", \"value\": \"${FPS}\"}
        ]
    }" \
    --query 'jobId' --output text)

echo "Submitted! Job ID: $JOB_ID"
echo ""
echo "Monitor:"
echo "  aws batch describe-jobs --jobs $JOB_ID --query 'jobs[0].status'"
echo ""
echo "Logs (once running):"
echo "  aws logs tail /aws/batch/job --follow --filter-pattern '$JOB_ID'"
