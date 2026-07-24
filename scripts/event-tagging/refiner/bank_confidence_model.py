"""One-shot: extract the CONFIDENCE classifier from the locked
models_final.pkl (sha recorded in PROTOCOL.md) into the small inference
pickle the goal-detect job banks + sha-pins. The localizer is deliberately
NOT included — it failed its timing gate and nothing timing-related wires.

Run: python bank_confidence_model.py
Prints the sha256 to pin as REFINER_SHA256 after uploading to the dated
weights prefix.
"""
from __future__ import annotations

import hashlib
import os

import joblib

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "models_final.pkl")
OUT = os.path.join(HERE, "refiner_confidence.pkl")


def main():
    src_sha = hashlib.sha256(open(SRC, "rb").read()).hexdigest()
    art = joblib.load(SRC)
    assert art["variant"] == "norm_only", art["variant"]
    ep_keys = [art["ep_keys"][i] for i in art["ep_cols"]]
    joblib.dump(dict(clf=art["clf"], ep_keys=ep_keys,
                     variant=art["variant"], source_sha=src_sha), OUT)
    sha = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    print(f"source models_final.pkl sha256 {src_sha}")
    print(f"wrote {OUT}")
    print(f"REFINER_SHA256={sha}")


if __name__ == "__main__":
    main()
