"""
Distance-threshold sweep on the v2-720p finetuned checkpoints (holdout only).

Question: v2 fires on ball-visible frames but recall@4px is ~1% with RMSE
~840px. Is that (a) detections are far-misses (floodlights) -> data problem,
or (b) near-misses failing a 4px-at-1080p gate -> localization problem?
Sweeps dist_threshold over {8, 16, 32} for the final (ep15, honest) and the
highest-firing (ep3, diagnostic-only — holdout-selected, never a headline
number) checkpoints from Modal volume wasb-weights:/finetune-v2-720p.

  WASB_DIR=<WASB-SBDT clone> modal run wasb_thresh_sweep.py
"""
import os
from pathlib import Path

import modal

DEFAULT_WASB = (
    "/private/tmp/claude-501/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/"
    "c5607fbe-2130-4da9-90c1-8fbad7a6a049/scratchpad/WASB-SBDT"
)
WASB_DIR = os.environ.get("WASB_DIR", DEFAULT_WASB)
PC = str(Path(__file__).resolve().parent.parent)
HOLDOUT = "veo_20260506_hb_cupfinal_goal_01"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "torch==2.2.2", "torchvision==0.17.2",
        "opencv-python-headless", "hydra-core==1.3.2", "omegaconf==2.3.0",
        "numpy<2", "pandas", "tqdm", "scipy", "Pillow", "PyYAML", "easydict",
        "matplotlib", "scikit-image", "filterpy",
    )
    .add_local_dir(WASB_DIR, "/wasb", copy=True)
    .add_local_file(f"{PC}/eval-dataset/clips/{HOLDOUT}.mp4", "/data/holdout.mp4", copy=True)
    .add_local_file(f"{PC}/eval-dataset/labels/{HOLDOUT}.json", "/data/holdout.json", copy=True)
)

app = modal.App("playhub-wasb-thresh-sweep", image=image)
vol = modal.Volume.from_name("wasb-weights")


def _write_cvat_xml(frames, out_path):
    import xml.etree.ElementTree as ET
    root = ET.Element("annotations")
    track = ET.SubElement(root, "track", {"id": "0", "label": "ball", "source": "manual"})
    for fr in frames:
        ball = fr.get("ball") or {}
        if not ball.get("visible") or ball.get("x") is None:
            continue
        p = ET.SubElement(track, "points", {
            "frame": str(int(fr["frame"])),  # labels are 0-indexed
            "outside": "0", "occluded": "0", "keyframe": "1",
            "points": f"{float(ball['x']):.2f},{float(ball['y']):.2f}",
        })
        ET.SubElement(p, "attribute", {"name": "used_in_game"}).text = "1"
    ET.ElementTree(root).write(out_path, encoding="utf-8", xml_declaration=True)


@app.function(gpu="A10G", timeout=7200, volumes={"/vol": vol})
def run():
    import json
    import subprocess

    os.makedirs(f"/root/datasets/soccer/frames/{HOLDOUT}", exist_ok=True)
    os.makedirs("/root/datasets/soccer/annos", exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "/data/holdout.mp4",
         "-start_number", "0", f"/root/datasets/soccer/frames/{HOLDOUT}/%05d.png"],
        check=True,
    )
    _write_cvat_xml(json.load(open("/data/holdout.json"))["frames"],
                    f"/root/datasets/soccer/annos/{HOLDOUT}.xml")

    report = ""
    for ckpt in ["checkpoint_ep15.pth.tar", "checkpoint_ep3.pth.tar"]:
        path = f"/vol/finetune-v2-720p/{ckpt}"
        assert os.path.exists(path), f"missing {path}"
        for dist in [8, 16, 32]:
            cmd = [
                "python3", "main.py", "--config-name=eval",
                "dataset=soccer", "model=wasb",
                f"detector.model_path={path}",
                "runner.gpus=[0]", "runner.vis_result=False",
                f"runner.eval.dist_threshold={dist}",
                "model.inp_height=720", "model.inp_width=1280",
                "model.out_height=720", "model.out_width=1280",
                "dataset.root_dir=/root/datasets/soccer",
                f"dataset.test.videos=[{HOLDOUT}]", "dataset.train.videos=[]",
                "dataloader.test_num_workers=4", "dataloader.inference_video_num_workers=4",
            ]
            out = subprocess.run(cmd, cwd="/wasb/src", capture_output=True, text=True)
            rows = [l for l in (out.stdout or "").splitlines() if "| TP" in l or "| --" in l or ("|" in l and "INFO" in l)]
            metric = "\n".join(rows[-3:]) if rows else (out.stdout or "")[-800:]
            report += f"\n===== {ckpt} @ dist={dist} (rc={out.returncode}) =====\n{metric}\n"
            print(report.splitlines()[-2], flush=True)
    return report


@app.local_entrypoint()
def main():
    print(run.remote())
