"""Modal app: fine-tune TrackNetV2 on the grassroots airborne dataset (MVP).

  modal run train_modal.py --epochs 20 --imgsz-h 720 --imgsz-w 1280

Outputs weights to the 'tracknet-weights' volume.

MVP notes (from the CV specialist):
- Do NOT use the vendor default 288x512 — it shrinks a 12px ball to ~3px and kills
  it. Train aspect-matched + higher, e.g. 720x1280 (1920x1080 → 1.5x shrink, ball
  ~8px). imgsz must be divisible by 8 (3 maxpools).
- Model is 3-in-3-out, 5-frame upgrade = change vendor Conv(9→15); start at 3 for
  the MVP, ablate later.
- Prefer fine-tune from pretrained badminton weights (vendor/tf2torch/track.pt,
  after `git apply tf2torch/diff.txt`) over cold start; pass --weights.
- GATE after training: run detect_tracknet.py on the frozen-holdout goal, then
  oracle.mjs — temporal-source oracle ≥60% (apex ≥40%) vs YOLO 10% = PROCEED.
"""
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent
app = modal.App("playhub-tracknet")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.1.1", "torchvision==0.16.1", "opencv-python==4.8.1.78",
        "numpy==1.26.2", "pandas==2.1.3", "pyyaml==6.0.1", "tqdm==4.66.1",
        "tensorboardX==2.6.2.2", "matplotlib==3.8.2", "torchsummary==1.5.1",
    )
    .add_local_dir(str(ROOT / "vendor"), "/work/vendor")
    .add_local_dir(str(ROOT / "dataset"), "/work/dataset")
)

vol = modal.Volume.from_name("tracknet-weights", create_if_missing=True)


@app.function(image=image, gpu="A10G", timeout=3600, volumes={"/out": vol})
def train(epochs: int = 20, imgsz_h: int = 720, imgsz_w: int = 1280,
          batch_size: int = 4, weights: str = ""):
    import os
    import subprocess

    os.chdir("/work/vendor")
    # Point the mounted match.yaml at the container dataset path.
    yp = Path("/work/dataset/match.yaml")
    body = "\n".join(l for l in yp.read_text().splitlines() if not l.startswith("path:"))
    yp.write_text(f"path: /work/dataset\n{body}\n")

    cmd = ["python", "train.py", "--data", "/work/dataset/match.yaml",
           "--epochs", str(epochs), "--imgsz", str(imgsz_h), str(imgsz_w),
           "--batch-size", str(batch_size), "--project", "/out/runs"]
    if weights:
        cmd += ["--weights", weights]
    print("RUN:", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    vol.commit()
    print("Done — weights under the 'tracknet-weights' volume at /out/runs", flush=True)


@app.local_entrypoint()
def main(epochs: int = 20, imgsz_h: int = 720, imgsz_w: int = 1280,
         batch_size: int = 4, weights: str = ""):
    train.remote(epochs=epochs, imgsz_h=imgsz_h, imgsz_w=imgsz_w,
                 batch_size=batch_size, weights=weights)
