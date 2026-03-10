"""
AWS Batch entrypoint for ball detection.

Reads env vars, downloads video from S3, runs detect_ball(), uploads result JSON to S3.

Environment variables:
  S3_BUCKET      - S3 bucket name
  INPUT_S3_KEY   - S3 key of input video (e.g. recordings/cfa/clip.mp4)
  OUTPUT_S3_KEY  - S3 key for output JSON (e.g. ball-detection/cfa/clip.json)
  OUTPUT_FPS     - Detection sample rate (default: 5)
  AWS_DEFAULT_REGION - AWS region (set by Batch)
"""

import json
import os
import sys

import boto3


def main():
    bucket = os.environ.get("S3_BUCKET")
    input_key = os.environ.get("INPUT_S3_KEY")
    output_key = os.environ.get("OUTPUT_S3_KEY")
    output_fps = float(os.environ.get("OUTPUT_FPS", "5"))

    if not bucket or not input_key or not output_key:
        print("ERROR: S3_BUCKET, INPUT_S3_KEY, and OUTPUT_S3_KEY are required", file=sys.stderr)
        sys.exit(1)

    print(f"Input:  s3://{bucket}/{input_key}", file=sys.stderr)
    print(f"Output: s3://{bucket}/{output_key}", file=sys.stderr)
    print(f"FPS:    {output_fps}", file=sys.stderr)

    s3 = boto3.client("s3")

    # Download video
    input_path = "/tmp/input.mp4"
    print("Downloading video from S3...", file=sys.stderr)
    s3.download_file(bucket, input_key, input_path)
    file_size_mb = os.path.getsize(input_path) / (1024 * 1024)
    print(f"Downloaded {file_size_mb:.1f} MB", file=sys.stderr)

    # Run detection
    sys.path.insert(0, "/app")
    from detect_ball import detect_ball

    print("Running ball detection...", file=sys.stderr)
    result = detect_ball(input_path, output_fps=output_fps)

    # Upload result
    result_json = json.dumps(result)
    print(f"Uploading result ({len(result_json)} bytes) to S3...", file=sys.stderr)
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=result_json,
        ContentType="application/json",
    )

    print(f"Done. {len(result.get('positions', []))} positions detected.", file=sys.stderr)

    # Cleanup
    os.unlink(input_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
