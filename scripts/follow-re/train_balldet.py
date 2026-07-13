"""Domain-adapt the Veo ball detector to the night/fisheye raw panorama. Assemble the
fusion-auto-labeled ballsets into a YOLO dataset (train = given clips, val = held-out), finetune
`yolov8m_veo_finetuned.pt` locally (MPS), save adapted weights. Held-out clip is NEVER trained on
→ honest generalization test (re-run phase0_yolo_test.py with the adapted weights on it).

  python3 train_balldet.py --train b923d40f,22776d6c --val 424e420a --epochs 15
"""
from __future__ import annotations
import os, sys, glob, shutil

BASE = "/tmp/imitation/ballset"
DS = f"{BASE}/dataset"
WEIGHTS = "/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop/yolov8m_veo_finetuned.pt"


def arg(k, d):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


def build(clips, val_frac=0.1):
    """copy all train-clip images, deterministic 90/10 split for YOLO val (checkpoint selection).
    The final TEST clip is NEVER passed here — kept pure for phase0_yolo_test."""
    nt = nv = 0
    for split in ("train", "val"):
        os.makedirs(f"{DS}/images/{split}", exist_ok=True); os.makedirs(f"{DS}/labels/{split}", exist_ok=True)
    for c in clips:
        for img in sorted(glob.glob(f"{BASE}/{c}/images/*.jpg")):
            b = os.path.basename(img); lab = f"{BASE}/{c}/labels/{b[:-4]}.txt"
            if not os.path.exists(lab):
                continue
            split = "val" if (hash(b) % 10 == 0) else "train"
            shutil.copy(img, f"{DS}/images/{split}/{b}"); shutil.copy(lab, f"{DS}/labels/{split}/{b[:-4]}.txt")
            nt += split == "train"; nv += split == "val"
    return nt, nv


def main():
    train = arg("--train", "b923d40f,22776d6c").split(",")
    epochs = int(arg("--epochs", "15"))
    imgsz = int(arg("--imgsz", "1280"))
    if os.path.exists(DS):
        shutil.rmtree(DS)
    nt, nv = build(train)
    print(f"train {nt} imgs / val {nv} imgs (90/10 split of {train}); TEST clip held out entirely")
    open(f"{DS}/data.yaml", "w").write(
        f"path: {DS}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n")

    from ultralytics import YOLO
    import torch
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(WEIGHTS)
    model.train(data=f"{DS}/data.yaml", epochs=epochs, imgsz=imgsz, batch=4, device=dev,
                project=f"{BASE}/runs", name="adapt", exist_ok=True, patience=0,
                mosaic=0.0, close_mosaic=0, degrees=0, shear=0, perspective=0,
                fliplr=0.5, hsv_v=0.4, lr0=0.001, optimizer="AdamW", verbose=True,
                plots=False, val=True)
    best = f"{BASE}/runs/adapt/weights/best.pt"
    dst = "/tmp/imitation/yolov8m_nazwa_adapt.pt"
    shutil.copy(best, dst)
    print(f"adapted weights -> {dst}")


if __name__ == "__main__":
    main()
