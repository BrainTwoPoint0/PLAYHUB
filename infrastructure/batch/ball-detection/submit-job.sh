#!/usr/bin/env bash
# Submit a ball detection job to AWS Batch.
# Must run with AWS_PROFILE=playhub.
#
# Usage:
#   ./submit-job.sh <input-s3-key> [output-s3-key] [fps]
#   ./submit-job.sh --url <video-url> <output-s3-key> [fps]
#
# Examples:
#   ./submit-job.sh recordings/cfa/clip.mp4
#   ./submit-job.sh --url "https://c.veocdn.com/..." ball-detection/cfa/clip.json

set -euo pipefail

JOB_QUEUE="playhub-ball-detection-queue"
JOB_DEFINITION="playhub-ball-detection"
S3_BUCKET="playhub-recordings"

if [[ "${1:-}" == "--url" ]]; then
    INPUT_URL="${2:?Usage: ./submit-job.sh --url <video-url> <output-s3-key> [fps]}"
    OUTPUT_KEY="${3:?Usage: ./submit-job.sh --url <video-url> <output-s3-key> [fps]}"
    FPS="${4:-5}"

    JOB_NAME="ball-detect-url-$(echo "$OUTPUT_KEY" | tr '/' '-' | sed 's/[^a-zA-Z0-9-]/-/g' | head -c 100)"

    echo "=== Submit Ball Detection Job ==="
    echo "Input:  $INPUT_URL"
    echo "Output: s3://${S3_BUCKET}/${OUTPUT_KEY}"
    echo "FPS:    ${FPS}"
    echo ""

    JOB_ID=$(aws batch submit-job \
        --job-name "$JOB_NAME" \
        --job-queue "$JOB_QUEUE" \
        --job-definition "$JOB_DEFINITION" \
        --container-overrides "{
            \"environment\": [
                {\"name\": \"INPUT_URL\", \"value\": \"${INPUT_URL}\"},
                {\"name\": \"OUTPUT_S3_KEY\", \"value\": \"${OUTPUT_KEY}\"},
                {\"name\": \"OUTPUT_FPS\", \"value\": \"${FPS}\"}
            ]
        }" \
        --query 'jobId' --output text)
else
    INPUT_KEY="${1:?Usage: ./submit-job.sh <input-s3-key> [output-s3-key] [fps]}"

    STEM="${INPUT_KEY#recordings/}"
    STEM="${STEM%.mp4}"
    OUTPUT_KEY="${2:-ball-detection/${STEM}.json}"
    FPS="${3:-5}"

    JOB_NAME="ball-detect-$(echo "$STEM" | tr '/' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | head -c 100)"

    echo "=== Submit Ball Detection Job ==="
    echo "Input:  s3://${S3_BUCKET}/${INPUT_KEY}"
    echo "Output: s3://${S3_BUCKET}/${OUTPUT_KEY}"
    echo "FPS:    ${FPS}"
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
fi

echo "Submitted! Job ID: $JOB_ID"
echo ""
echo "Monitor:"
echo "  aws batch describe-jobs --jobs $JOB_ID --query 'jobs[0].status'"
echo ""
echo "Logs (once running):"
echo "  aws logs tail /aws/batch/job --follow --filter-pattern '$JOB_ID'"
