"""Modal GPU domain-adaptation finetune for the Nazwa raw-panorama ball detector.
Same recipe as train_balldet.py (local/MPS was ~11 min/epoch → unusable) but on A10G.
Dataset ships via Volume `nazwa-ballset` (push first — see below). 90/10 split in-container
(same hash rule as local); the TEST clip (424e420a) must NEVER be in --clips.

  # one-time dataset push (from /tmp/imitation/ballset):
  #   modal volume create nazwa-ballset
  #   modal volume put nazwa-ballset /tmp/imitation/ballset/<clip> /<clip>   (per train clip)
  # train:
  #   modal run train_balldet_modal.py --clips b923d40f,22776d6c,48e16a16,986c7896 --epochs 15
Weights land at /tmp/imitation/yolov8m_nazwa_adapt_v2.pt.
"""
from pathlib import Path
import modal

HERE = Path(__file__).resolve().parent
WEIGHTS = HERE.parent / "portrait-crop" / "yolov8m_veo_finetuned.pt"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0")
    .pip_install("torch==2.2.2", "torchvision==0.17.2", "ultralytics==8.2.103",
                 "opencv-python-headless", "numpy<2")
    .add_local_file(str(WEIGHTS), "/model/yolov8m_veo_finetuned.pt", copy=True)
)
vol = modal.Volume.from_name("nazwa-ballset", create_if_missing=True)
app = modal.App("nazwa-balldet-train", image=image)


@app.function(gpu="A10G", timeout=3600, volumes={"/data": vol})
def train(clips: str, epochs: int = 15, imgsz: int = 1280, batch: int = 8) -> bytes:
    import glob, os, shutil
    DS = "/root/ds"
    for split in ("train", "val"):
        os.makedirs(f"{DS}/images/{split}", exist_ok=True)
        os.makedirs(f"{DS}/labels/{split}", exist_ok=True)
    nt = nv = 0
    for c in clips.split(","):
        for img in sorted(glob.glob(f"/data/{c}/images/*.jpg")):
            b = os.path.basename(img); lab = f"/data/{c}/labels/{b[:-4]}.txt"
            if not os.path.exists(lab):
                continue
            split = "val" if (hash(b) % 10 == 0) else "train"
            shutil.copy(img, f"{DS}/images/{split}/{b}")
            shutil.copy(lab, f"{DS}/labels/{split}/{b[:-4]}.txt")
            nt += split == "train"; nv += split == "val"
    print(f"train {nt} / val {nv} images from [{clips}]")
    open(f"{DS}/data.yaml", "w").write(f"path: {DS}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n")

    from ultralytics import YOLO
    model = YOLO("/model/yolov8m_veo_finetuned.pt")
    model.train(data=f"{DS}/data.yaml", epochs=epochs, imgsz=imgsz, batch=batch, device=0,
                project="/root/runs", name="adapt", exist_ok=True, patience=0,
                mosaic=0.0, close_mosaic=0, degrees=0, shear=0, perspective=0,
                fliplr=0.5, hsv_v=0.4, lr0=0.001, optimizer="AdamW", plots=False, val=True)
    return open("/root/runs/adapt/weights/best.pt", "rb").read()


@app.local_entrypoint()
def main(clips: str = "b923d40f,22776d6c,48e16a16,986c7896", epochs: int = 15):
    assert "424e420a" not in clips, "424e420a is the held-out TEST clip — never train on it"
    out = Path("/tmp/imitation/yolov8m_nazwa_adapt_v2.pt")
    out.write_bytes(train.remote(clips, epochs=epochs))
    print(f"adapted-v2 weights -> {out} ({out.stat().st_size/1e6:.0f} MB)")
