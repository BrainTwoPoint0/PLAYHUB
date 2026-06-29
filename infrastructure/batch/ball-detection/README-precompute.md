# Goal precompute — AWS Batch GPU

Bulk-detects the ball on every uncached **goal** highlight (~4,920) on spot GPU and
upserts the result into `playhub_crop_detections`, so the editor opens those clips
**instantly** (and at 25fps for accuracy — no fast-play misses). Runs on AWS credits.

Reuses the compute env / queue / ECR / job role from `batch-ball-detection.tf`;
`batch-precompute.tf` adds the Supabase secret + execution role + the array job def.

## Cost
~4,920 clips × ~$0.014 (spot g5/g6 @25fps) ≈ **~$67 in credits, one-time** (cached
forever). Scales to zero when idle. AWS Budget alert at $150 recommended.

## Pieces
| File | What |
|---|---|
| `Dockerfile` | CUDA image; **now includes `supervision`** (was missing → image crashed) |
| `entrypoint.py` | array-shard mode: reads S3 manifest shard → detect → idempotent upsert via Supabase REST |
| `build_manifest.py` | queries goals-missing-cache → JSONL → S3 (the frozen work-list) |
| `../../terraform/batch-precompute.tf` | secret, execution role, array job def |

## Deploy + run (AWS_PROFILE=playhub, eu-west-2, account 274921264686)

```bash
# 0. Bump the compute env in batch-ball-detection.tf (verify against your provider):
#      instance_type = ["g5.xlarge","g6.xlarge"]; allocation_strategy = "SPOT_CAPACITY_OPTIMIZED"
#      max_vcpus = 128; min_vcpus = 0   # + ensure GPU-optimized (ECS_AL2_NVIDIA) AMI

# 1. Build + push the (fixed) image — capture the digest
cd infrastructure/batch/ball-detection
AWS_PROFILE=playhub aws ecr get-login-password --region eu-west-2 \
  | docker login --username AWS --password-stdin 274921264686.dkr.ecr.eu-west-2.amazonaws.com
./build-and-push.sh   # copies detect_ball.py + the .pt weight into the build context

# 2. Terraform (Supabase key passed in, never committed)
cd ../../terraform
AWS_PROFILE=playhub TF_VAR_supabase_service_key="$KEY" terraform plan      # SURFACES any provider-schema issues
AWS_PROFILE=playhub TF_VAR_supabase_service_key="$KEY" terraform apply -target=aws_secretsmanager_secret_version.supabase_service_key -target=aws_iam_role.batch_execution -target=aws_batch_job_definition.ball_precompute

# 3. Generate the manifest (goals missing cache → JSONL → S3)
cd ../batch/ball-detection
DATABASE_URL="postgres://...supabase..." \
  python3 build_manifest.py --out s3://playhub-recordings-eu-west-2/manifests/goals-$(date +%Y%m%d).jsonl
# prints arraySize + the exact submit command

# 4. SMOKE TEST one shard first (catches GPU/driver/ECR-auth bugs for 1 job, not 246)
AWS_PROFILE=playhub aws batch submit-job --job-name goal-smoke \
  --job-queue playhub-ball-detection-queue --job-definition playhub-ball-precompute \
  --container-overrides 'environment=[{name=INPUT_URL,value=<a goal url>},{name=HIGHLIGHT_ID,value=<its id>}]'
# confirm: lands on a GPU, "CUDA OK", upserts 1 row to playhub_crop_detections

# 5. Full array run (use the size from step 3, e.g. 4920/20 = 246)
AWS_PROFILE=playhub aws batch submit-job --job-name goal-bulk-$(date +%Y%m%d) \
  --job-queue playhub-ball-detection-queue --job-definition playhub-ball-precompute \
  --array-properties size=246 \
  --container-overrides 'environment=[{name=MANIFEST_S3_URI,value=s3://playhub-recordings-eu-west-2/manifests/goals-YYYYMMDD.jsonl},{name=SHARD_SIZE,value=20}]'

# 6. Monitor
AWS_PROFILE=playhub aws batch describe-jobs --jobs <parent-id> --query 'jobs[0].arrayProperties.statusSummary'
# logs: /aws/batch/playhub-ball-detection in CloudWatch
# verify: SELECT count(*) FROM playhub_crop_detections;  → climbs toward ~4,920

# 7. Re-run is safe — regenerate the manifest (now smaller) + resubmit; upserts dedupe.
```

## The 3 things most likely to bite (per the infra review)
1. **GPU AMI/driver** — the CE must use the ECS GPU-optimized AMI or `cuda.is_available()` is False and YOLO grinds on CPU. `entrypoint.py` asserts CUDA and exits loud; the smoke test catches it.
2. **Spot capacity** — two instance types (g5+g6) + `SPOT_CAPACITY_OPTIMIZED` + small 20-clip shards make reclamation cheap; if pools dry up jobs queue (don't fail).
3. **ECR auth** — the execution role needs `AmazonECSTaskExecutionRolePolicy` (it does); a lifecycle-expired pinned digest fails the pull.

## Ongoing (new goals as Veo adds them)
Same job def. A scheduled Lambda (EventBridge) queries new uncached goals and submits
a small array job — or just re-run steps 3+5 periodically.
