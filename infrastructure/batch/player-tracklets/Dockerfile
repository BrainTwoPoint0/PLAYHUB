# Player-tracklets Batch job — Python, CPU-only, no video. Fetches Spiideo's
# tracklets + detections data streams, solves the per-game metric->ray
# homography, and publishes the per-player spotlight track.
# ECR Public mirror — Docker Hub anonymous pulls 429 from CodeBuild's
# shared NAT IPs (hit 2026-07-15); AWS's mirror has no such limit.
FROM public.ecr.aws/docker/library/python:3.12-slim

# ffmpeg: extracts the 3 validation-PNG frames from the presigned raw
# panorama via HTTP seek (no full download).
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

RUN useradd -r -u 10001 tracklets
USER tracklets

CMD ["python", "entrypoint.py"]
