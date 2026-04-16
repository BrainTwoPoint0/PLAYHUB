"""
Portrait Crop — Modal GPU endpoint.

Runs detect_ball.py on a T4 GPU for ~5s processing per clip.

Setup:
  pip install modal
  modal token new

Deploy:
  cd PLAYHUB
  modal deploy scripts/portrait-crop/modal_app.py

Test:
  curl -X POST --data-binary @clip.mp4 https://karimfawaz--playhub-portrait-crop-process.modal.run
"""

import fastapi
import modal
import os

# Bumped on breaking changes to the response schema so routes can correlate
# a job with the Modal code that produced it.
MODAL_APP_VERSION = "2026.04.15.2"

app = modal.App("playhub")

# Shared secret required on every request. The Modal web endpoints are public
# URLs — without this check, anyone who discovered the URL could burn CPU
# budget and run arbitrary ffmpeg. The route layer sets `MODAL_SHARED_SECRET`
# server-side and forwards it as `X-Modal-Auth` on every inbound call.
_secret = modal.Secret.from_name("playhub-modal-shared-secret")


def _require_shared_secret(request: fastapi.Request):
    """Return a JSONResponse if auth fails, else None."""
    from starlette.responses import JSONResponse

    expected = os.environ.get("MODAL_SHARED_SECRET")
    if not expected:
        # Fail closed — missing secret means misconfiguration, not an open endpoint.
        return JSONResponse({"error": "server misconfigured"}, status_code=500)
    provided = request.headers.get("x-modal-auth") or ""
    if provided != expected:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return None

script_dir = os.path.dirname(os.path.abspath(__file__))

# Build container image with all dependencies + model + detect script.
# ffmpeg is added for ffprobe — the ML-Ops-specialist-flagged Veo-encoder-
# change canary needs codec/resolution/fps/bitrate per inference so a
# silent upstream re-encode doesn't get misattributed to detector drift.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "ffmpeg")
    .pip_install(
        "ultralytics",
        "opencv-python-headless",
        "norfair",
        "numpy",
        "scipy",
        "sahi",
        "fastapi[standard]",
    )
    .add_local_file(
        os.path.join(script_dir, "yolov8m_forzasys_soccer.pt"),
        "/app/yolov8m_forzasys_soccer.pt",
    )
    .add_local_file(
        os.path.join(script_dir, "detect_ball.py"),
        "/app/detect_ball.py",
    )
)


def _ffprobe_fingerprint(path: str) -> dict:
    """Capture codec + resolution + fps + bitrate + color_space via ffprobe.

    Returned dict lands in playhub_crop_jobs.codec_fingerprint so we can
    detect when Veo / Spiideo silently change their output encoding. Any
    `ffprobe` failure is non-fatal — detection proceeds without the
    fingerprint rather than aborting the user's save.
    """
    import json
    import subprocess

    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries",
                "stream=codec_name,width,height,r_frame_rate,bit_rate,color_space,pix_fmt",
                "-show_entries",
                "format=duration,size,format_name,bit_rate",
                "-of", "json",
                path,
            ],
            timeout=10,
        )
        probe = json.loads(out)
        stream = (probe.get("streams") or [{}])[0]
        fmt = probe.get("format") or {}
        fps_num, fps_den = (stream.get("r_frame_rate") or "0/1").split("/")
        try:
            fps = float(fps_num) / float(fps_den) if float(fps_den) else None
        except (ValueError, ZeroDivisionError):
            fps = None
        return {
            "codec": stream.get("codec_name"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "fps": fps,
            "bit_rate": int(stream.get("bit_rate")) if stream.get("bit_rate") else None,
            "color_space": stream.get("color_space"),
            "pix_fmt": stream.get("pix_fmt"),
            "format_name": fmt.get("format_name"),
            "duration_seconds": float(fmt.get("duration")) if fmt.get("duration") else None,
            "size_bytes": int(fmt.get("size")) if fmt.get("size") else None,
        }
    except Exception as exc:  # noqa: BLE001 — never fail detection on probe error
        return {"error": str(exc)[:200]}


# 25fps detection + SAHI 640 slices on low-detection clips can push T4 past
# Modal's 150s web-endpoint sync limit. A10G (~3x faster) keeps all 10 eval
# clips comfortably under 150s at ~$0.002/clip — still negligible.
@app.function(image=image, gpu="A10G", timeout=600, secrets=[_secret])
@modal.fastapi_endpoint(method="POST")
async def portrait_crop_process(request: fastapi.Request):
    """Accept raw video bytes, return ball positions JSON."""
    import sys
    import tempfile

    from starlette.responses import JSONResponse

    auth_err = _require_shared_secret(request)
    if auth_err is not None:
        return auth_err

    # Reject bodies larger than 500MB before we buffer them in RAM. Modal
    # default container memory is tight and large uploads can OOM the worker.
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > 500 * 1024 * 1024:
        return JSONResponse({"error": "video too large (max 500MB)"}, status_code=413)

    body = await request.body()
    if len(body) == 0:
        return JSONResponse({"error": "Empty body"}, status_code=400)

    # Write video to temp file
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(body)
        tmp_path = f.name

    try:
        # Capture codec fingerprint before detection — ffprobe is fast (<100ms)
        # and gives us the canary signal even if detection itself fails.
        codec_fingerprint = _ffprobe_fingerprint(tmp_path)

        # Import detect_ball from the bundled script
        sys.path.insert(0, "/app")
        from detect_ball import detect_ball

        import time as _time
        t0 = _time.monotonic()
        # Sample at video fps — downstream smoothing is quantized by
        # this sample rate, so undersampling here is the dominant source
        # of visible crop jitter. 25fps comfortably under T4 per-clip budget.
        result = detect_ball(tmp_path, output_fps=25.0)
        modal_inference_ms = int((_time.monotonic() - t0) * 1000)

        # Extend the response schema so downstream routes can persist
        # codec_fingerprint + modal_inference_ms into playhub_crop_jobs.
        result["codec_fingerprint"] = codec_fingerprint
        result["modal_inference_ms"] = modal_inference_ms
        result["modal_app_version"] = MODAL_APP_VERSION
        return JSONResponse(result)
    finally:
        os.unlink(tmp_path)


# ─────────────────────────── render_portrait ──────────────────────────────
# Takes a source video + keyframes produced by the editor, renders the 9:16
# portrait MP4 via ffmpeg sendcmd, returns the bytes. No Supabase credentials
# here on purpose — the upload to storage is the route's job.

# Render has no GPU requirement (pure CPU ffmpeg), so use a cheaper function
# profile than detection. Bumping cpu so libx264 doesn't bottleneck.
@app.function(image=image, cpu=4.0, timeout=600, secrets=[_secret])
@modal.fastapi_endpoint(method="POST")
async def render_portrait(request: fastapi.Request):
    """Render a 9:16 portrait MP4 from source video + keyframes.

    Accepts multipart/form-data:
      video       — binary mp4
      keyframes   — JSON array of {time_seconds, x_pixels}
      scene_changes — JSON array of split-point timestamps (optional)

    Returns the rendered MP4 bytes with Content-Type: video/mp4.
    """
    import json
    import subprocess
    import tempfile

    from starlette.responses import Response, JSONResponse

    auth_err = _require_shared_secret(request)
    if auth_err is not None:
        return auth_err

    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > 500 * 1024 * 1024:
        return JSONResponse({"error": "payload too large (max 500MB)"}, status_code=413)

    try:
        form = await request.form()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"bad form: {exc}"[:200]}, status_code=400)

    video_field = form.get("video")
    keyframes_raw = form.get("keyframes")
    scene_changes_raw = form.get("scene_changes") or "[]"
    if video_field is None or keyframes_raw is None:
        return JSONResponse({"error": "missing video or keyframes"}, status_code=400)

    try:
        video_bytes = await video_field.read()
        keyframes = json.loads(keyframes_raw if isinstance(keyframes_raw, str) else await keyframes_raw.read())
        scene_changes = json.loads(scene_changes_raw if isinstance(scene_changes_raw, str) else await scene_changes_raw.read())
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"bad payload: {exc}"[:200]}, status_code=400)

    if not isinstance(keyframes, list) or len(keyframes) == 0:
        return JSONResponse({"error": "keyframes must be a non-empty array"}, status_code=400)
    if len(keyframes) > 500:
        return JSONResponse({"error": "too many keyframes (max 500)"}, status_code=413)
    if len(video_bytes) == 0:
        return JSONResponse({"error": "empty video"}, status_code=400)

    src_path = None
    cmd_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video_bytes)
            src_path = f.name

        # Probe the source so we know fps + duration for per-frame interpolation.
        probe = _ffprobe_fingerprint(src_path)
        fps = probe.get("fps") or 30.0
        duration = probe.get("duration_seconds") or 0.0
        width = probe.get("width") or 1920
        height = probe.get("height") or 1080
        if width < 608 or height < 1:
            return JSONResponse({"error": f"source too small: {width}x{height}"}, status_code=400)
        crop_w = round(height * 9 / 16)
        if crop_w >= width:
            return JSONResponse({"error": "source already portrait or narrower than 9:16"}, status_code=400)

        # Sort + clip keyframes to duration; each keyframe has (time_seconds, x_pixels).
        kfs = sorted(
            ({"t": float(kf["time_seconds"]), "x": int(kf["x_pixels"])} for kf in keyframes),
            key=lambda k: k["t"],
        )
        splits = sorted(float(s) for s in scene_changes)

        # Interpolate to per-frame crop x with scene-change hold semantics —
        # matches the editor's `interpolateCropX` behaviour so what the user
        # previewed in the browser is what gets rendered.
        def sample(t: float) -> int:
            if t <= kfs[0]["t"]:
                return kfs[0]["x"]
            if t >= kfs[-1]["t"]:
                return kfs[-1]["x"]
            for i in range(len(kfs) - 1):
                a, b = kfs[i], kfs[i + 1]
                if a["t"] <= t <= b["t"]:
                    split_between = next((s for s in splits if a["t"] < s < b["t"]), None)
                    if split_between is not None:
                        return a["x"] if t < split_between else b["x"]
                    progress = (t - a["t"]) / max(b["t"] - a["t"], 1e-6)
                    return round(a["x"] + (b["x"] - a["x"]) * progress)
            return kfs[-1]["x"]

        total_frames = max(1, int(round(duration * fps)))
        lines = []
        last_x = -1
        for i in range(total_frames):
            t = i / fps
            x = max(0, min(width - crop_w, sample(t)))
            if x == last_x:
                continue
            lines.append(f"{t:.6f} crop x {x};")
            last_x = x
        if not lines:
            lines = [f"0.000000 crop x {max(0, min(width - crop_w, kfs[0]['x']))};"]

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False, mode="w") as f:
            f.write("\n".join(lines) + "\n")
            cmd_path = f.name

        out_path = tempfile.mktemp(suffix=".mp4")
        initial_x = max(0, min(width - crop_w, kfs[0]["x"]))
        filter_chain = (
            f"sendcmd=f='{cmd_path}',"
            f"crop={crop_w}:{height}:{initial_x}:0,"
            f"scale=1080:1920"
        )

        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", src_path,
                    "-vf", filter_chain,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                    "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart",
                    out_path,
                ],
                check=True,
                timeout=540,
                capture_output=True,
            )
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode(errors="replace")[-2000:]
            return JSONResponse(
                {"error": "ffmpeg render failed", "stderr": stderr},
                status_code=500,
            )

        with open(out_path, "rb") as f:
            mp4 = f.read()
        return Response(
            content=mp4,
            media_type="video/mp4",
            headers={
                "X-Modal-App-Version": MODAL_APP_VERSION,
                "X-Render-Frames": str(total_frames),
                "X-Render-Keyframes": str(len(kfs)),
            },
        )
    finally:
        for p in (src_path, cmd_path, out_path):
            if p and os.path.exists(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass
