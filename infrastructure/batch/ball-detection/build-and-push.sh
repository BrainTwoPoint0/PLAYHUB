#!/usr/bin/env bash
# Build ball-detection Docker image and push to ECR.
# Must run with AWS_PROFILE=playhub.
#
# Usage: ./build-and-push.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PORTRAIT_CROP_DIR="$REPO_ROOT/scripts/portrait-crop"

AWS_REGION="${AWS_REGION:-eu-west-2}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="playhub-ball-detection"
IMAGE_TAG="latest"
FULL_IMAGE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

echo "=== Ball Detection — Build & Push ==="
echo "Account:  $AWS_ACCOUNT_ID"
echo "Region:   $AWS_REGION"
echo "Image:    $FULL_IMAGE"
echo ""

# Copy detect_ball.py and model into build context
echo "Copying detect_ball.py and model into build context..."
cp "$PORTRAIT_CROP_DIR/detect_ball.py" "$SCRIPT_DIR/detect_ball.py"
cp "$PORTRAIT_CROP_DIR/yolov8m_forzasys_soccer.pt" "$SCRIPT_DIR/yolov8m_forzasys_soccer.pt"

cleanup() {
    echo "Cleaning up copied files..."
    rm -f "$SCRIPT_DIR/detect_ball.py" "$SCRIPT_DIR/yolov8m_forzasys_soccer.pt"
}
trap cleanup EXIT

# Build for linux/amd64 (g4dn instances are x86_64)
echo "Building Docker image (linux/amd64)..."
docker build --platform linux/amd64 -t "$ECR_REPO:$IMAGE_TAG" "$SCRIPT_DIR"

# ECR login
echo "Logging into ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Tag and push
echo "Pushing to ECR..."
docker tag "$ECR_REPO:$IMAGE_TAG" "$FULL_IMAGE"
docker push "$FULL_IMAGE"

echo ""
echo "=== Done ==="
echo "Image: $FULL_IMAGE"
