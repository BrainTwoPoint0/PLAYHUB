# Ball detection container — YOLOv8m + Norfair Kalman tracker on CUDA
# Used by AWS Batch (g4dn.xlarge spot) and optionally Modal

FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

# Avoid interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install Python and OpenCV dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages (match modal_app.py deps + boto3 for S3)
RUN pip3 install --no-cache-dir \
    ultralytics \
    opencv-python-headless \
    norfair \
    numpy \
    scipy \
    sahi \
    boto3

WORKDIR /app

# Copy model, detection script, and entrypoint
COPY yolov8m_forzasys_soccer.pt /app/yolov8m_forzasys_soccer.pt
COPY detect_ball.py /app/detect_ball.py
COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python3", "/app/entrypoint.py"]
