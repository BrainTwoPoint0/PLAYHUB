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

app = modal.App("playhub")

script_dir = os.path.dirname(os.path.abspath(__file__))

# Build container image with all dependencies + model + detect script
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
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


@app.function(image=image, gpu="T4", timeout=180)
@modal.fastapi_endpoint(method="POST")
async def portrait_crop_process(request: fastapi.Request):
    """Accept raw video bytes, return ball positions JSON."""
    import sys
    import tempfile

    from starlette.responses import JSONResponse

    body = await request.body()
    if len(body) == 0:
        return JSONResponse({"error": "Empty body"}, status_code=400)

    # Write video to temp file
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(body)
        tmp_path = f.name

    try:
        # Import detect_ball from the bundled script
        sys.path.insert(0, "/app")
        from detect_ball import detect_ball

        result = detect_ball(tmp_path, output_fps=5.0)
        return JSONResponse(result)
    finally:
        os.unlink(tmp_path)
