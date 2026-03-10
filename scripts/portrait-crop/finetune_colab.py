"""
YOLOv8 Fine-Tuning Script for Google Colab (Free GPU)

Run this in Google Colab with GPU runtime:
  Runtime > Change runtime type > T4 GPU

Steps:
  1. Extract frames:     python3 extract_frames.py <clips_dir> /tmp/veo-frames
  2. Upload to Roboflow:  Create project, annotate ball/player, export YOLOv8
  3. Run this script in Colab with your Roboflow API key

Estimated time: ~30-45 min on T4 GPU for 50 epochs with 330 images.
"""

# --- Run in Google Colab ---
# !pip install ultralytics roboflow

from ultralytics import YOLO
import os

# --- CONFIG ---
ROBOFLOW_API_KEY = "lL0lsEYAWYNkUsjNSbxi"
ROBOFLOW_WORKSPACE = "karims-workspace-wgkny"
ROBOFLOW_PROJECT = "veo-ball-detection"
ROBOFLOW_VERSION = 1

# Fine-tuning from Forzasys soccer weights (transfer learning)
# Upload yolov8m_forzasys_soccer.pt to Colab or use base YOLOv8m
BASE_MODEL = "yolov8m.pt"  # Use "yolov8m_forzasys_soccer.pt" if uploaded

EPOCHS = 50
IMGSZ = 1280  # Higher resolution for small ball detection
BATCH = 8     # Reduce to 4 if OOM on T4


def download_dataset():
    """Download annotated dataset from Roboflow."""
    from roboflow import Roboflow
    rf = Roboflow(api_key=ROBOFLOW_API_KEY)
    project = rf.workspace(ROBOFLOW_WORKSPACE).project(ROBOFLOW_PROJECT)
    dataset = project.version(ROBOFLOW_VERSION).download("yolov8")
    return dataset.location


def train(dataset_path: str):
    """Fine-tune YOLOv8 on Veo footage."""
    model = YOLO(BASE_MODEL)

    results = model.train(
        data=os.path.join(dataset_path, "data.yaml"),
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        # Transfer learning settings
        freeze=10,            # Freeze first 10 layers (backbone) — learn sports-specific features
        lr0=0.001,            # Lower learning rate for fine-tuning (don't destroy pretrained features)
        lrf=0.01,             # Final learning rate factor
        # Augmentation for football
        hsv_h=0.015,          # Hue augmentation
        hsv_s=0.7,            # Saturation
        hsv_v=0.4,            # Value
        degrees=5.0,          # Rotation (slight — pitch is mostly horizontal)
        translate=0.1,        # Translation
        scale=0.5,            # Scale augmentation (important — ball appears at different sizes)
        fliplr=0.5,           # Horizontal flip (football is symmetric)
        mosaic=1.0,           # Mosaic augmentation
        # Performance
        workers=2,
        device=0,             # GPU
        project="veo-finetune",
        name="run1",
    )

    # Export best model
    best_path = os.path.join("veo-finetune", "run1", "weights", "best.pt")
    print(f"\nBest model saved to: {best_path}")
    print("Download this file and place it in scripts/portrait-crop/")
    print("Then update detect_ball.py to use 'yolov8m_veo_finetuned.pt'")

    return best_path


if __name__ == "__main__":
    print("Step 1: Downloading dataset from Roboflow...")
    dataset_path = download_dataset()

    print(f"\nStep 2: Training YOLOv8 on {dataset_path}...")
    best = train(dataset_path)

    print(f"\nDone! Best model: {best}")
    print("\nValidation metrics are in veo-finetune/run1/")
