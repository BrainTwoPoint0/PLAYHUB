# Goal-detect Batch job — CPU-only Python. Runs the frozen goal-detection
# chain on the tracklets artifact and cuts review clips with ffmpeg.
# ECR Public mirror — Docker Hub anonymous pulls 429 from CodeBuild's shared
# NAT IPs (hit 2026-07-15); AWS's mirror has no such limit.
FROM public.ecr.aws/docker/library/python:3.12-slim

# ffmpeg: review-clip extraction against the presigned produced mp4.
# No torch, no opencv, no GPU anything — the chain is sklearn + numpy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Glob, not a name list — naming files individually drifts silently and the
# job dies at ModuleNotFoundError on Fargate AFTER the sweep claimed the row
# (veo-capture lesson, 2026-07-15). .dockerignore excludes tests/caches.
COPY *.py ./

RUN useradd -r -u 10001 goaldetect
USER goaldetect

CMD ["python", "entrypoint.py"]
