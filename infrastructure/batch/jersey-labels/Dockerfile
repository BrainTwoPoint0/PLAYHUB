# Jersey-labels Batch job — Python + CPU torch. Reads jersey numbers off the
# banked raw panorama, assembles (number, kit) slots, republishes the
# enriched tracklets.json.
# ECR Public mirror — Docker Hub anonymous pulls 429 from CodeBuild's shared
# NAT IPs (hit 2026-07-15); AWS's mirror has no such limit.
FROM public.ecr.aws/docker/library/python:3.12-slim

# libgl1/libglib2.0-0: opencv-python (ultralytics hard-requires the non-
# headless name). git: pinned strhub clone. No ffmpeg — frames come from
# cv2.VideoCapture on the downloaded panorama (opencv's bundled codecs).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates git libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# strhub (PARSeq architecture) — pinned SHA of the Koshkina & Elder
# jersey-number-pipeline (CVPR 2024), which vendors parseq under str/.
# Weights load with weights_only=True; only code is taken from the clone.
ARG PIPELINE_SHA=007d54e5530a66616ed5081ca35e0028b36aadb5
RUN git clone --filter=blob:none https://github.com/mkoshkina/jersey-number-pipeline.git \
  && cd jersey-number-pipeline && git checkout "$PIPELINE_SHA" \
  && rm -rf .git

# Glob, not a name list — naming files individually drifts silently and the
# job dies at ModuleNotFoundError on Fargate AFTER the sweep claimed the row
# (veo-capture lesson, 2026-07-15). .dockerignore excludes tests/caches.
# build_track.py + mesh_rays.py are staged into the zip from
# ../player-tracklets by the deploy step (single-source shared modules).
COPY *.py ./

# Writable caches for the non-root user (ultralytics/torch write configs);
# YOLO_OFFLINE keeps ultralytics from phoning home from the public-IP task.
ENV YOLO_CONFIG_DIR=/tmp/ultralytics \
    TORCH_HOME=/tmp/torch \
    MPLCONFIGDIR=/tmp/mpl \
    YOLO_OFFLINE=True

RUN useradd -r -u 10001 jersey
USER jersey

CMD ["python", "entrypoint.py"]
