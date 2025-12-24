# PLAYHUB Infrastructure

AWS infrastructure for PLAYHUB recording sync and live streaming.

## Components

### Recording Sync Lambda
Automatically syncs Spiideo recordings to S3 every 15 minutes.

- **Lambda**: `playhub-sync-recordings`
- **Trigger**: EventBridge rule (every 15 minutes)
- **Timeout**: 15 minutes (syncs one recording per invocation)
- **Alerting**: SNS email notifications on failure

### Live Streaming (Future)
- MediaLive channels
- MediaPackage endpoints
- CloudFront distribution

## Deployment

### Prerequisites

1. AWS CLI configured with appropriate credentials
2. Terraform installed (v1.0+)
3. Node.js 20+ for Lambda build

### Deploy Sync Lambda

```bash
# 1. Build the Lambda
cd infrastructure/lambda/sync-recordings
npm install
npm run package

# 2. Configure Terraform variables
cd ../../terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 3. Deploy
terraform init
terraform plan
terraform apply -target=aws_lambda_function.sync_recordings \
                -target=aws_cloudwatch_event_rule.sync_schedule \
                -target=aws_cloudwatch_event_target.sync_lambda \
                -target=aws_lambda_permission.eventbridge_sync
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SYNC_ENDPOINT` | PLAYHUB sync API URL |
| `SYNC_API_KEY` | API key for authentication |

### Manual Trigger

Test the Lambda manually:

```bash
aws lambda invoke \
  --function-name playhub-sync-recordings \
  --log-type Tail \
  response.json

# View logs
cat response.json
```

### Monitoring & Alerts

**CloudWatch Alarms** (email to admin@playbacksports.ai):
- **Error Alarm**: Triggers if Lambda fails
- **Timeout Alarm**: Triggers if Lambda runs > 14 minutes (warning before timeout)

After deployment, you'll receive a confirmation email from AWS SNS - click the link to activate alerts.

**View Logs:**
- Log group: `/aws/lambda/playhub-sync-recordings`
- Metrics: AWS Lambda console

## Cost Estimate

| Resource | Monthly Cost |
|----------|--------------|
| Lambda (720 invocations × 15 min × 256MB) | ~$0 (free tier) |
| EventBridge | Free |
| CloudWatch Logs | ~$0 (under 5GB) |
| **Total** | **~$0/month** |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   EventBridge   │────▶│     Lambda      │────▶│  PLAYHUB API    │
│  (every 15 min) │     │ sync-recordings │     │ /api/recordings │
└─────────────────┘     └─────────────────┘     │     /sync       │
                                                 └────────┬────────┘
                                                          │
                        ┌─────────────────┐     ┌─────────▼────────┐
                        │       S3        │◀────│     Spiideo      │
                        │   Recordings    │     │   (download)     │
                        └─────────────────┘     └──────────────────┘
```
