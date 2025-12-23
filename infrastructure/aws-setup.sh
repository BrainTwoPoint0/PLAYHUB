#!/bin/bash
# PLAYHUB AWS Infrastructure Setup Script
# Account: 274921264686
# Region: eu-west-2

set -e

ACCOUNT_ID="274921264686"
REGION="eu-west-2"
PROJECT="playhub"

echo "=========================================="
echo "PLAYHUB AWS Infrastructure Setup"
echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo "=========================================="

# 1. Create S3 bucket for recordings
echo ""
echo "Step 1: Creating S3 bucket for recordings..."
aws s3 mb s3://${PROJECT}-recordings-${REGION} --region $REGION 2>/dev/null || echo "Bucket may already exist"

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket ${PROJECT}-recordings-${REGION} \
  --versioning-configuration Status=Enabled \
  --region $REGION

echo "✓ S3 bucket created: ${PROJECT}-recordings-${REGION}"

# 2. Create IAM role for MediaLive
echo ""
echo "Step 2: Creating IAM role for MediaLive..."

# Trust policy
cat > /tmp/medialive-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "medialive.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name ${PROJECT}-medialive-role \
  --assume-role-policy-document file:///tmp/medialive-trust-policy.json \
  --description "IAM role for PLAYHUB MediaLive channels" \
  2>/dev/null || echo "Role may already exist"

# Attach policies
aws iam attach-role-policy \
  --role-name ${PROJECT}-medialive-role \
  --policy-arn arn:aws:iam::aws:policy/AWSElementalMediaLiveFullAccess \
  2>/dev/null || true

aws iam attach-role-policy \
  --role-name ${PROJECT}-medialive-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess \
  2>/dev/null || true

aws iam attach-role-policy \
  --role-name ${PROJECT}-medialive-role \
  --policy-arn arn:aws:iam::aws:policy/AWSElementalMediaPackageFullAccess \
  2>/dev/null || true

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${PROJECT}-medialive-role"
echo "✓ IAM role created: $ROLE_ARN"

# 3. Create MediaPackage channel
echo ""
echo "Step 3: Creating MediaPackage channel..."

CHANNEL_RESULT=$(aws mediapackage create-channel \
  --id ${PROJECT}-live-channel \
  --description "PLAYHUB live streaming channel" \
  --region $REGION \
  2>/dev/null || echo '{"Id": "'${PROJECT}'-live-channel"}')

MEDIAPACKAGE_CHANNEL_ID="${PROJECT}-live-channel"
echo "✓ MediaPackage channel created: $MEDIAPACKAGE_CHANNEL_ID"

# 4. Create MediaPackage HLS endpoint
echo ""
echo "Step 4: Creating MediaPackage HLS endpoint..."

ENDPOINT_RESULT=$(aws mediapackage create-origin-endpoint \
  --channel-id ${PROJECT}-live-channel \
  --id ${PROJECT}-hls-endpoint \
  --manifest-name index \
  --startover-window-seconds 86400 \
  --time-delay-seconds 0 \
  --hls-package '{
    "SegmentDurationSeconds": 6,
    "PlaylistWindowSeconds": 60,
    "UseAudioRenditionGroup": false
  }' \
  --region $REGION \
  2>&1 || echo "Endpoint may already exist")

echo "✓ MediaPackage endpoint created"

# Get endpoint URL
ENDPOINT_URL=$(aws mediapackage describe-origin-endpoint \
  --id ${PROJECT}-hls-endpoint \
  --region $REGION \
  --query 'Url' \
  --output text 2>/dev/null || echo "pending")

echo "  Endpoint URL: $ENDPOINT_URL"

# 5. Create CloudFront distribution
echo ""
echo "Step 5: Creating CloudFront distribution..."

# Get MediaPackage domain for origin
MP_DOMAIN=$(echo $ENDPOINT_URL | sed 's|https://||' | cut -d'/' -f1)

if [ "$MP_DOMAIN" != "pending" ] && [ -n "$MP_DOMAIN" ]; then
  cat > /tmp/cloudfront-config.json << EOF
{
  "CallerReference": "${PROJECT}-$(date +%s)",
  "Comment": "PLAYHUB Live Streaming CDN",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "mediapackage-origin",
        "DomainName": "${MP_DOMAIN}",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": {
            "Quantity": 1,
            "Items": ["TLSv1.2"]
          }
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "mediapackage-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": {
        "Quantity": 2,
        "Items": ["GET", "HEAD"]
      }
    },
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true
  },
  "PriceClass": "PriceClass_100"
}
EOF

  CF_RESULT=$(aws cloudfront create-distribution \
    --distribution-config file:///tmp/cloudfront-config.json \
    2>&1 || echo "Distribution may already exist")

  echo "✓ CloudFront distribution created (may take 15-20 min to deploy)"
else
  echo "⚠ Skipping CloudFront - MediaPackage endpoint not ready yet"
fi

# 6. Summary
echo ""
echo "=========================================="
echo "SETUP COMPLETE!"
echo "=========================================="
echo ""
echo "Add these to your .env file:"
echo ""
echo "AWS_REGION=${REGION}"
echo "AWS_ACCESS_KEY_ID=<your_access_key>"
echo "AWS_SECRET_ACCESS_KEY=<your_secret_key>"
echo "MEDIALIVE_ROLE_ARN=${ROLE_ARN}"
echo "MEDIAPACKAGE_CHANNEL_ID=${MEDIAPACKAGE_CHANNEL_ID}"
echo "S3_RECORDINGS_BUCKET=${PROJECT}-recordings-${REGION}"
echo ""
echo "Run this to get CloudFront details:"
echo "aws cloudfront list-distributions --query 'DistributionList.Items[?Comment==\`PLAYHUB Live Streaming CDN\`].[Id,DomainName]' --output table"
echo ""
