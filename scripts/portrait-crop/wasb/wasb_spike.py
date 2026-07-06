"""
B-ball spike: WASB zero-shot soccer ball detection on our frozen grassroots
holdout clip, scored by WASB's own localization accuracy. Runs on Modal A10G.

  modal run wasb_spike.py

Pipeline in-container: gdown soccer weights -> ffmpeg extract frames ->
generate the CVAT-style XML WASB expects from our dense label JSON -> run
WASB's eval harness (main.py --config-name=eval dataset=soccer model=wasb) ->
return the printed accuracy table. This is the fastest "how far does SOTA get
zero-shot" number; head-to-head vs our YOLOv8-Forzasys baseline via oracle.mjs
is the follow-up.
"""
import modal

SC = "/private/tmp/claude-501/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/8d04849d-a9cc-41e8-b602-fe371522ef6c/scratchpad"
PC = "/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop"
CLIP = "veo_20260506_hb_cupfinal_goal_01"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    # torch 2.2 — new enough for A10G/cu121, old enough that torch.load defaults
    # weights_only=False (WASB's detector.py calls torch.load without that kw).
    .pip_install(
        "torch==2.2.2", "torchvision==0.17.2",
        "opencv-python-headless", "hydra-core==1.3.2", "omegaconf==2.3.0",
        "numpy<2", "pandas", "tqdm", "gdown", "scipy", "Pillow", "PyYAML", "easydict",
        "matplotlib", "scikit-image", "filterpy",
    )
    .add_local_dir(f"{SC}/WASB-SBDT", "/wasb", copy=True)
    .add_local_file(f"{PC}/eval-dataset/clips/{CLIP}.mp4", "/data/holdout.mp4", copy=True)
    .add_local_file(f"{PC}/eval-dataset/labels/{CLIP}.json", "/data/holdout.json", copy=True)
)

app = modal.App("playhub-wasb-spike", image=image)


def _write_cvat_xml(frames, out_path):
    """WASB load_xml expects: root>track>points[frame,outside,occluded,points='x,y']
    with a child <attribute name='used_in_game'>1</attribute>. Emit one point per
    VISIBLE labeled frame; load_xml fills the rest as not-visible."""
    import xml.etree.ElementTree as ET
    root = ET.Element("annotations")
    track = ET.SubElement(root, "track", {"id": "0", "label": "ball", "source": "manual"})
    n = 0
    for fr in frames:
        ball = fr.get("ball") or {}
        if not ball.get("visible"):
            continue
        x, y = ball.get("x"), ball.get("y")
        if x is None or y is None:
            continue
        p = ET.SubElement(track, "points", {
            # our labels are 1-indexed; soccer.py assumes 0-indexed frames.
            "frame": str(int(fr["frame"]) - 1),
            "outside": "0", "occluded": "0", "keyframe": "1",
            "points": f"{float(x):.2f},{float(y):.2f}",
        })
        a = ET.SubElement(p, "attribute", {"name": "used_in_game"})
        a.text = "1"
        n += 1
    ET.ElementTree(root).write(out_path, encoding="utf-8", xml_declaration=True)
    return n


@app.function(gpu="A10G", timeout=1800)
def run():
    import os, json, subprocess, glob

    os.makedirs("/root/datasets/soccer/frames/holdout", exist_ok=True)
    os.makedirs("/root/datasets/soccer/annos", exist_ok=True)

    print("== 1. download WASB soccer weights ==", flush=True)
    import gdown
    dst = "/root/wasb_soccer.pth.tar"
    got = gdown.download(id="1pg0MpMtKZ6ziYEr4oyfKYPOO3hjLw94l", output=dst, quiet=False)
    if not got or not os.path.exists(dst):
        # fallback: fuzzy URL form
        gdown.download(
            url="https://drive.google.com/uc?id=1pg0MpMtKZ6ziYEr4oyfKYPOO3hjLw94l",
            output=dst, quiet=False, fuzzy=True,
        )
    sz = os.path.getsize(dst)
    print("weights:", sz, "bytes", flush=True)
    if sz < 1_000_000:  # a Google "quota exceeded" HTML page is tiny
        print("!! weights file suspiciously small — likely a GDrive quota/HTML page:", flush=True)
        print(open(dst, "rb").read()[:400], flush=True)
        raise SystemExit("weights download failed")

    print("== 2. extract frames ==", flush=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "/data/holdout.mp4",
         "-start_number", "0", "/root/datasets/soccer/frames/holdout/%05d.png"],
        check=True,
    )
    nframes = len(glob.glob("/root/datasets/soccer/frames/holdout/*.png"))
    print("frames extracted:", nframes, flush=True)

    print("== 3. generate XML from labels ==", flush=True)
    lbl = json.load(open("/data/holdout.json"))
    frames = lbl["frames"]
    nvis = _write_cvat_xml(frames, "/root/datasets/soccer/annos/holdout.xml")
    print(f"labels: {len(frames)} frames, {nvis} visible-ball annotations", flush=True)

    print("== 4. run WASB eval (soccer, zero-shot) ==", flush=True)
    cmd = [
        "python3", "main.py", "--config-name=eval",
        "dataset=soccer", "model=wasb",
        "detector.model_path=/root/wasb_soccer.pth.tar",
        "runner.gpus=[0]",
        "runner.vis_result=True",  # draw pred (+GT) ball onto frames
        "dataset.root_dir=/root/datasets/soccer",
        "dataset.test.videos=[holdout]",
        "dataset.train.videos=[]",
    ]
    print(" ".join(cmd), flush=True)
    out = subprocess.run(cmd, cwd="/wasb/src", capture_output=True, text=True)
    tail = (out.stdout or "")[-5000:] + "\n----STDERR----\n" + (out.stderr or "")[-3000:]

    # Montage ~8 vis frames (spread across the clip) so we can SEE pred-vs-GT.
    import base64, cv2, numpy as np
    vis_pngs = sorted(glob.glob("/root/outputs/**/0_holdout/*.png", recursive=True))
    montage_b64 = ""
    print(f"vis frames found: {len(vis_pngs)}", flush=True)
    if vis_pngs:
        pick = [vis_pngs[i] for i in np.linspace(0, len(vis_pngs) - 1, 8).astype(int)]
        rows = []
        for i in range(0, 8, 2):
            a = cv2.imread(pick[i]); b = cv2.imread(pick[i + 1])
            h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
            a = cv2.resize(a, (w, h)); b = cv2.resize(b, (w, h))
            rows.append(cv2.hconcat([a, b]))
        montage = cv2.vconcat(rows)
        montage = cv2.resize(montage, (1400, int(1400 * montage.shape[0] / montage.shape[1])))
        ok, buf = cv2.imencode(".png", montage)
        if ok:
            montage_b64 = base64.b64encode(buf.tobytes()).decode()
    return {
        "text": f"rc={out.returncode}\nframes={nframes} visible_labels={nvis}\n\n{tail}",
        "montage_b64": montage_b64,
    }


@app.local_entrypoint()
def main():
    import base64
    res = run.remote()
    print(res["text"])
    if res.get("montage_b64"):
        out = "/private/tmp/claude-501/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/8d04849d-a9cc-41e8-b602-fe371522ef6c/scratchpad/wasb_overlay.png"
        with open(out, "wb") as f:
            f.write(base64.b64decode(res["montage_b64"]))
        print("MONTAGE_SAVED:", out)
    else:
        print("NO montage produced")
