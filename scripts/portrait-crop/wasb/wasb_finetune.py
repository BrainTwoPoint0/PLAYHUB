"""
B-ball finetune: WASB soccer weights finetuned on our 7 labeled grassroots
clips (2,170 dense frames), evaluated on the frozen holdout with WASB's own
harness. Runs on Modal A10G. Companion to wasb_spike.py (zero-shot: recall
0.23% — predictions in the stands; this answers "does finetuning move it").

  WASB_DIR=<path-to-WASB-SBDT-clone> modal run wasb_finetune.py
  (or clone WASB-SBDT into this session's scratchpad — see DEFAULT_WASB)

What it does in-container:
  1. patch WASB: register the shipped-but-disabled Trainer, fix its stale
     `.inference_videos` import, fix VideosInferenceRunner.run() dropping the
     model= arg (else mid-training evals silently re-eval the FROZEN weights),
     add runner.init_weights (load pretrained soccer ckpt), write a train
     runner config.
  2. build the dataset. IMPORTANT indexing fix vs wasb_spike.py: our label
     JSONs are 0-INDEXED (CVAT; prep_dataset.py agrees) — the spike shifted
     GT by -1. Harmless for the zero-shot verdict (RMSE 580px) but corrected
     here for training targets. Train clips are trimmed to their dense
     labeled range [fmin..fmax] and renumbered from 0, else WASB's load_xml
     marks out-of-range frames as ball-not-visible -> false negatives.
     Holdout keeps ALL frames (same eval condition as the spike).
  3. finetune (stock recipe: 512x288, adadelta lr 1.0, wbce heatmap loss,
     hflip+crop aug) with holdout inference every 5 epochs (learning curve).
  4. final A/B on the holdout: corrected-GT zero-shot baseline vs final-epoch
     checkpoint (honest number — NOT the holdout-selected best_model, which
     is also saved but is model selection on the holdout).
  5. checkpoints -> Modal volume 'wasb-weights'; montage saved locally.

Decision rule (from RESUME.md): recall 0% -> meaningful ==> scale the label
corpus (MOG2 semi-auto). Barely moves ==> bottleneck is data, not model.
"""
import os
from pathlib import Path

import modal

DEFAULT_WASB = (
    "/private/tmp/claude-501/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/"
    "c5607fbe-2130-4da9-90c1-8fbad7a6a049/scratchpad/WASB-SBDT"
)
WASB_DIR = os.environ.get("WASB_DIR", DEFAULT_WASB)
PC = str(Path(__file__).resolve().parent.parent)  # .../scripts/portrait-crop
ED = f"{PC}/eval-dataset"

HOLDOUT = "veo_20260506_hb_cupfinal_goal_01"
# v3 (2026-07-08): the original 7 v2 clips + 17 human-verified corpus clips
# (CVAT-labelled this campaign, ~9.2k visible-ball frames, 24 venues/dates/
# lighting, 2024→2026). The diverse-corpus test of "does more labelled data
# move recall past the v2 ~1% plateau". Task 86 (veo_20250201-fa5ca4fc…) is
# DELIBERATELY held out of training as an honest witness — scored v2-vs-v3
# offline post-train (Karim flagged it as mixed good/bad-by-period).
TRAIN_CLIPS = [
    # --- original v2 corpus ---
    "veo_20240918_goalkick_01",
    "veo_20250927_cfa_u9_freekick_01",
    "veo_20260502_goal_01",
    "veo_20260502_match_goal_01",
    "veo_20260502_passage_01",
    "veo_20260502b_goal_01",
    "veo_20260505_sefa_u19_goal_01",
    # --- v3 diverse corpus (17 verified clips; task 86 held out) ---
    "veo_20250122-soccer-elite-fa-u19-vs-emc-afd80965_dd182e79",
    "veo_20240925-match-27-sep-2024-4996873f_532cdab9",
    "veo_20241026-boys-jpl-u13-vs-russellers-fc-4210dc19_40121690",
    "veo_20250208-cfamezzie-u9-yellow-vs-hannakins-farm-u8s-07b3f179_868f9e4e",
    "veo_20250222-south-london-kings-b0e9e038_bb4b53d5",
    "veo_20250312-soccer-elite-fa-u19-vs-vs-kinetic-mapes-9a793f01_98428c28",
    "veo_20250322-girls-jpl-u12-vs-afc-wimbledon-b08b7a1d_5c0f9a08",
    "veo_20250614-match-cfa-u9-24434165_31191747",
    "veo_20250719-boys-jpl-u13-2526-vs-vs-metrogas-284a6319_d5ebf462",
    "veo_20251105-soccer-elite-fa-u19-vs-emc-tactics-wed-e417237a_09e219a9",
    "veo_20260328-girls-jpl-u12-vs-greenwich-boro-vac44fec_8c20f846",
    "veo_20260516-match-16-may-2026-vb948536_6e44dcdf",
    "veo_20260517-elite-london-academy-u9-vs-the-a-academy-u9-v27c2e8a_ca03b278",
    "veo_20260606-soccer-elite-fa-u12-vs-2627-u12s-erith-town-vb9fd673_7cb86410",
    "veo_20260628-roehampton-elite-u8-vs-forza-skill-u8-va2aa67a_94c3c401",
    "veo_london-youth-league-20260510-lfs-yellow-vs-champs-u8-v2061dad_a671dcc6",
    "veo_london-youth-league-20260510-nsfc-silver-vs-national-harrow-blue-u7-v507aa60_6bf646e0",
]
ALL_CLIPS = TRAIN_CLIPS + [HOLDOUT]

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    # torch 2.2: torch.load defaults weights_only=False (WASB calls it bare).
    .pip_install(
        "torch==2.2.2", "torchvision==0.17.2",
        "opencv-python-headless", "hydra-core==1.3.2", "omegaconf==2.3.0",
        "numpy<2", "pandas", "tqdm", "gdown", "scipy", "Pillow", "PyYAML", "easydict",
        "matplotlib", "scikit-image", "filterpy",
    )
    .add_local_dir(WASB_DIR, "/wasb", copy=True)
)
for c in ALL_CLIPS:
    image = image.add_local_file(f"{ED}/clips/{c}.mp4", f"/data/clips/{c}.mp4", copy=True)
    image = image.add_local_file(f"{ED}/labels/{c}.json", f"/data/labels/{c}.json", copy=True)

app = modal.App("playhub-wasb-finetune", image=image)
vol = modal.Volume.from_name("wasb-weights", create_if_missing=True)

# v1 result (A10G, stock 512x288, 30ep): TP=0 at every checkpoint, train loss
# flat 2.5e-4 = collapse-to-background. Clips are 1920x1080; at 512x288 the
# 5-8px ball is 1.3-2px — below detectable scale. v2 tests the resolution
# hypothesis: WASB_GPU=A100-40GB modal run wasb_finetune.py --inp-h 720
# --inp-w 1280 --batch 2 --max-epochs 15 --sched 8,12 --vi-step 3
# --skip-baseline --vol-tag finetune-v2-720p
GPU = os.environ.get("WASB_GPU", "A10G")

TRAIN_RUNNER_YAML = """name: train
device: cuda
gpus: [0]
max_epochs: 30
init_weights:
vis_result: False
vis_hm: False
vis_traj: False
model_path:
split: test
fp1_filename:
find_fp1_epochs: []
best_model_name: best_model.pth.tar
test:
  run: False
  epoch_start: 999999
  epoch_step: 1
  run_before_train: False
  run_after_train_with_best: False
inference_video:
  run: True
  epoch_start: 0
  epoch_step: 5
  run_before_train: False
  run_after_train_with_best: False
eval:
  score_threshold: 0.5
  dist_threshold: 4
"""


def _patch_wasb():
    """Surgical string patches; every pattern asserted so drift fails loud."""
    def patch(path, old, new):
        p = Path(path)
        s = p.read_text()
        assert old in s, f"patch pattern missing in {path}: {old[:60]!r}"
        p.write_text(s.replace(old, new, 1))

    # 1. register the Trainer
    patch("/wasb/src/runners/__init__.py",
          "# from .train_and_test import Trainer",
          "from .train_and_test import Trainer")
    patch("/wasb/src/runners/__init__.py",
          "    #'train': Trainer,",
          "    'train': Trainer,")
    # 2. Trainer imports a module renamed to eval.py in the public repo
    patch("/wasb/src/runners/train_and_test.py",
          "from .inference_videos import VideosInferenceRunner",
          "from .eval import VideosInferenceRunner")
    # 3. run() drops model= -> mid-training evals would re-eval frozen weights
    patch("/wasb/src/runners/eval.py",
          "    def run(self, model=None, model_dir=None):\n        return self._run_model()",
          "    def run(self, model=None, model_dir=None):\n        return self._run_model(model=model)")
    # 4. init from pretrained soccer weights (finetune, not cold start)
    patch("/wasb/src/runners/train_and_test.py",
          "        self._model                     = build_model(cfg)",
          "        self._model                     = build_model(cfg)\n"
          "        _iw = cfg['runner'].get('init_weights', None)\n"
          "        if _iw:\n"
          "            _ckpt = torch.load(_iw, map_location='cpu')\n"
          "            self._model.load_state_dict(_ckpt.get('model_state_dict', _ckpt))\n"
          "            log.info('initialized model weights from %s', _iw)")
    Path("/wasb/src/configs/runner/train.yaml").write_text(TRAIN_RUNNER_YAML)
    print("WASB patched: Trainer registered, model= passthrough, init_weights, train runner config")


def _write_cvat_xml(frames, out_path, offset=0):
    """Labels are 0-indexed (CVAT). XML frame = json_frame - offset."""
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
            "frame": str(int(fr["frame"]) - offset),
            "outside": "0", "occluded": "0", "keyframe": "1",
            "points": f"{float(x):.2f},{float(y):.2f}",
        })
        a = ET.SubElement(p, "attribute", {"name": "used_in_game"})
        a.text = "1"
        n += 1
    ET.ElementTree(root).write(out_path, encoding="utf-8", xml_declaration=True)
    return n


def _build_dataset():
    import glob
    import json
    import shutil
    import subprocess

    root = "/root/datasets/soccer"
    os.makedirs(f"{root}/annos", exist_ok=True)
    for clip in ALL_CLIPS:
        lbl = json.load(open(f"/data/labels/{clip}.json"))
        frames = lbl["frames"]
        fids = [int(f["frame"]) for f in frames]
        fmin, fmax = min(fids), max(fids)
        tmp = f"/root/tmp_frames/{clip}"
        os.makedirs(tmp, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f"/data/clips/{clip}.mp4",
             "-start_number", "0", f"{tmp}/%05d.png"],
            check=True,
        )
        out_dir = f"{root}/frames/{clip}"
        os.makedirs(out_dir, exist_ok=True)
        if clip == HOLDOUT:
            # keep ALL frames — identical eval condition to the zero-shot spike
            for src in glob.glob(f"{tmp}/*.png"):
                shutil.move(src, f"{out_dir}/{os.path.basename(src)}")
            nvis = _write_cvat_xml(frames, f"{root}/annos/{clip}.xml", offset=0)
        else:
            # trim to labeled range + renumber from 0, else out-of-range frames
            # become false "ball not visible" training targets
            for fid in range(fmin, fmax + 1):
                src = f"{tmp}/{fid:05d}.png"
                assert os.path.exists(src), f"{clip}: frame {fid} missing (range {fmin}-{fmax})"
                shutil.move(src, f"{out_dir}/{fid - fmin:05d}.png")
            nvis = _write_cvat_xml(frames, f"{root}/annos/{clip}.xml", offset=fmin)
        kept = len(glob.glob(f"{out_dir}/*.png"))
        print(f"  {clip}: kept {kept} frames (label range {fmin}-{fmax}), {nvis} visible annos", flush=True)
        shutil.rmtree(tmp)
    return root


def _run_eval(weights, vis, tag, extra=()):
    """Same eval invocation as wasb_spike.py, corrected GT indexing."""
    import subprocess
    cmd = [
        "python3", "main.py", "--config-name=eval",
        "dataset=soccer", "model=wasb",
        f"detector.model_path={weights}",
        "runner.gpus=[0]",
        f"runner.vis_result={'True' if vis else 'False'}",
        "dataset.root_dir=/root/datasets/soccer",
        f"dataset.test.videos=[{HOLDOUT}]",
        "dataset.train.videos=[]",
        "dataloader.test_num_workers=4", "dataloader.inference_video_num_workers=4",
        *extra,
    ]
    print(f"== EVAL [{tag}] ==\n" + " ".join(cmd), flush=True)
    out = subprocess.run(cmd, cwd="/wasb/src", capture_output=True, text=True)
    tail = (out.stdout or "")[-3500:] + "\n----STDERR(tail)----\n" + (out.stderr or "")[-1200:]
    return f"\n########## EVAL [{tag}] rc={out.returncode} ##########\n{tail}"


@app.function(gpu=GPU, timeout=25200, volumes={"/vol": vol})
def run(max_epochs: int = 30, inp_h: int = 0, inp_w: int = 0, batch: int = 8,
        sched: str = "10,20", vi_step: int = 5, skip_baseline: bool = False,
        vol_tag: str = "finetune-v1"):
    import base64
    import glob
    import shutil
    import subprocess

    import cv2
    import numpy as np

    _patch_wasb()

    # inp_h/inp_w = 0 -> stock 512x288. HRNet is fully conv, so higher input
    # res is a pure config change; out res kept equal to input res.
    res_over = []
    if inp_h and inp_w:
        assert inp_h % 8 == 0 and inp_w % 8 == 0, "input dims must be /8"
        res_over = [
            f"model.inp_height={inp_h}", f"model.inp_width={inp_w}",
            f"model.out_height={inp_h}", f"model.out_width={inp_w}",
        ]

    print("== 1. weights ==", flush=True)
    import gdown
    dst = "/root/wasb_soccer.pth.tar"
    gdown.download(id="1pg0MpMtKZ6ziYEr4oyfKYPOO3hjLw94l", output=dst, quiet=False)
    assert os.path.getsize(dst) > 1_000_000, "weights download failed (HTML quota page?)"

    print("== 2. dataset ==", flush=True)
    _build_dataset()

    report = ""
    if not skip_baseline:
        print("== 3. corrected-GT zero-shot baseline ==", flush=True)
        report += _run_eval(dst, vis=False, tag="zero-shot, corrected GT")
    if res_over:
        print(f"== 3b. zero-shot at {inp_w}x{inp_h} (resolution-only arm) ==", flush=True)
        report += _run_eval(dst, vis=False, tag=f"zero-shot @ {inp_w}x{inp_h}", extra=res_over)

    print("== 4. finetune ==", flush=True)
    train_videos = ",".join(TRAIN_CLIPS)
    cmd = [
        "python3", "main.py", "--config-name=eval",
        "runner=train", "dataset=soccer", "model=wasb",
        "+loss=hm_wbce", "+optimizer=adadelta_multistep",
        f"runner.max_epochs={max_epochs}",
        f"runner.init_weights={dst}",
        "runner.gpus=[0]",
        f"runner.inference_video.epoch_step={vi_step}",
        f"optimizer.scheduler.stepsize=[{sched}]",
        "dataset.root_dir=/root/datasets/soccer",
        f"dataset.train.videos=[{train_videos}]",
        f"dataset.test.videos=[{HOLDOUT}]",
        "dataloader.train=True", "dataloader.test=False",
        "dataloader.train_clip=False", "dataloader.test_clip=True",
        f"dataloader.sampler.train_batch_size={batch}",
        "dataloader.train_num_workers=4", "dataloader.test_num_workers=4",
        "dataloader.inference_video_num_workers=4",
        "transform.train.horizontal_flip.p=0.5",
        "transform.train.crop.p=0.5",
        "output_dir=/root/train_out",
        *res_over,
    ]
    print(" ".join(cmd), flush=True)
    # stream train output live (visible in `modal run` logs -> early-abort on
    # a flat loss) while also keeping a tail for the final report
    proc = subprocess.Popen(cmd, cwd="/wasb/src", stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = []
    for line in proc.stdout:
        line = line.rstrip("\n")
        if "it/s]" not in line and "s/it]" not in line:  # drop tqdm spam
            print(line, flush=True)
        lines.append(line)
    rc = proc.wait()
    train_tail = "\n".join(lines)[-9000:]
    report += f"\n########## TRAIN rc={rc} ##########\n{train_tail}"

    class _TR:  # keep downstream checks unchanged
        returncode = rc
    tr = _TR()

    # persist every checkpoint before anything else can fail
    os.makedirs(f"/vol/{vol_tag}", exist_ok=True)
    for f in glob.glob("/root/train_out/*.pth.tar"):
        shutil.copy(f, f"/vol/{vol_tag}/{os.path.basename(f)}")
    vol.commit()
    print(f"checkpoints persisted to wasb-weights volume:/{vol_tag}", flush=True)

    montage_b64 = ""
    final_ckpt = f"/root/train_out/checkpoint_ep{max_epochs}.pth.tar"
    if tr.returncode == 0 and os.path.exists(final_ckpt):
        print("== 5. finetuned eval (final epoch, honest number) ==", flush=True)
        report += _run_eval(final_ckpt, vis=True, tag=f"finetuned ep{max_epochs}", extra=res_over)
        vis_pngs = sorted(glob.glob(f"/root/outputs/**/0_{HOLDOUT}/*.png", recursive=True))
        print(f"vis frames: {len(vis_pngs)}", flush=True)
        if vis_pngs:
            pick = [vis_pngs[i] for i in np.linspace(0, len(vis_pngs) - 1, 8).astype(int)]
            rows = []
            for i in range(0, 8, 2):
                a, b = cv2.imread(pick[i]), cv2.imread(pick[i + 1])
                h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
                rows.append(cv2.hconcat([cv2.resize(a, (w, h)), cv2.resize(b, (w, h))]))
            m = cv2.vconcat(rows)
            m = cv2.resize(m, (1400, int(1400 * m.shape[0] / m.shape[1])))
            ok, buf = cv2.imencode(".png", m)
            if ok:
                montage_b64 = base64.b64encode(buf.tobytes()).decode()
    else:
        report += f"\n!! final checkpoint missing or train failed (rc={tr.returncode}) — skipped finetuned eval"

    return {"text": report, "montage_b64": montage_b64}


@app.function(gpu=GPU, timeout=5400, volumes={"/vol": vol})
def eval_sweep(vol_tag: str = "finetune-v3-bigcorpus", epochs: str = "1,2,3,4,5,6,7",
               inp_h: int = 720, inp_w: int = 1280):
    """Re-evaluate persisted checkpoints on the frozen holdout — recovers the
    true per-epoch trajectory when a detached run lost its return value."""
    import os
    import re
    _build_dataset()  # builds HOLDOUT frames+annos (among ALL_CLIPS)
    res_over = [f"model.inp_height={inp_h}", f"model.inp_width={inp_w}",
                f"model.out_height={inp_h}", f"model.out_width={inp_w}"]
    lines = []
    for e in [x.strip() for x in epochs.split(",")]:
        ckpt = f"/vol/{vol_tag}/{'best_model' if e=='best' else f'checkpoint_ep{e}'}.pth.tar"
        if not os.path.exists(ckpt):
            lines.append(f"ep{e}\tMISSING"); continue
        rep = _run_eval(ckpt, vis=False, tag=f"ep{e}", extra=res_over)
        rows = re.findall(r"\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*"
                          r"\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|", rep)
        if rows:
            tp, tn, fp1, fp2, fp, fn, prec, rec, f1, acc = rows[-1]
            lines.append(f"ep{e}\tTP={tp}\tFP={fp}\tFN={fn}\trecall={rec}\tprec={prec}\tF1={f1}")
        else:
            lines.append(f"ep{e}\t(parse-fail) tail:{rep[-240:]}")
    return "\n".join(lines)


@app.local_entrypoint()
def sweep(vol_tag: str = "finetune-v3-bigcorpus", epochs: str = "1,2,3,4,5,6,7,best"):
    print("=== v3 checkpoint eval sweep on frozen holdout (hb_cupfinal) ===")
    print(eval_sweep.remote(vol_tag=vol_tag, epochs=epochs))


@app.local_entrypoint()
def main(max_epochs: int = 30, inp_h: int = 0, inp_w: int = 0, batch: int = 8,
         sched: str = "10,20", vi_step: int = 5, skip_baseline: bool = False,
         vol_tag: str = "finetune-v1"):
    import base64
    res = run.remote(max_epochs=max_epochs, inp_h=inp_h, inp_w=inp_w, batch=batch,
                     sched=sched, vi_step=vi_step, skip_baseline=skip_baseline,
                     vol_tag=vol_tag)
    print(res["text"])
    if res.get("montage_b64"):
        out = str(Path(__file__).resolve().parent / f"wasb_{vol_tag}_overlay.png")
        with open(out, "wb") as f:
            f.write(base64.b64decode(res["montage_b64"]))
        print("MONTAGE_SAVED:", out)
    else:
        print("NO montage produced")
