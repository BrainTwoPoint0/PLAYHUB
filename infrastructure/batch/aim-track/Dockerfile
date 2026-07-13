# Aim-track Batch job — Python + OpenCV. Registers the produced Play render
# against the raw VirtualPanorama (SIFT, CPU-only) and publishes the
# {t, pan, tilt, fov} auto-follow track next to the scene mesh.
FROM python:3.12-slim

# opencv-python-headless wheels bundle ffmpeg for VideoCapture; libgl not needed
# for the headless build. ca-certificates for HTTPS to Supabase + S3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY register.py aim_convert.py entrypoint.py ./

# Non-root; /tmp holds the downloaded videos (Fargate ephemeral storage).
RUN useradd -r -u 10001 aimtrack
USER aimtrack

CMD ["python", "entrypoint.py"]
