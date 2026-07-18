"""Kit-color descriptor + clustering (B2, measured).

The kit is load-bearing for the slot key: a pitch-side staffer in a black
graphic tee reads '11' at conf up to 1.00 — no confidence or geometric filter
catches it, but street clothes match neither team's kit cluster. Both HCT
kits are near-achromatic, and stadium lighting spans L 50-160 for ONE kit
across the frame, so raw Lab medians fail (measured); the working feature is
grass-normalized two-tone:

    [dL_p80, dL_p20, a_med, b_med]     dL = shirt L - grass-at-feet L

k-means (k by silhouette over 2..6, seeded) on chains that carry a confident
in-match near-play number (warmup tops must not define the kit centroids);
every crop is then assigned to its nearest centroid with an outlier distance
('other' kit = -1). Per-CROP assignments are the body-impurity detector.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from harvest import MARGIN

OUTLIER_LAB = 35.0
KMEANS_SEED = 7
KMEANS_ITERS = 50
K_RANGE = range(2, 7)


def shirt_lab(img: np.ndarray, h_px: float):
    """Illumination-normalized kit descriptor for one padded BGR crop.
    Shirt region = box rows 15-45%, central 60% width; grass reference =
    bottom 15% of the crop. Returns a 4-vector or None."""
    import cv2
    h, w = img.shape[:2]
    pad = MARGIN * h_px
    bx0, bx1 = pad, w - pad
    by0 = pad
    y0 = int(round(by0 + 0.15 * h_px))
    y1 = int(round(by0 + 0.45 * h_px))
    xc0 = int(round(bx0 + 0.20 * (bx1 - bx0)))
    xc1 = int(round(bx0 + 0.80 * (bx1 - bx0)))
    reg = img[max(0, y0):min(h, y1), max(0, xc0):min(w, xc1)]
    grass = img[int(h * 0.85):, :]
    if reg.size == 0 or grass.size == 0:
        return None
    lab = cv2.cvtColor(reg, cv2.COLOR_BGR2Lab).reshape(-1, 3).astype(float)
    lab_g = np.median(cv2.cvtColor(grass, cv2.COLOR_BGR2Lab)
                      .reshape(-1, 3).astype(float), axis=0)
    dl = lab[:, 0] - lab_g[0]
    return np.array([np.percentile(dl, 80), np.percentile(dl, 20),
                     np.median(lab[:, 1]), np.median(lab[:, 2])])


def kmeans(k: int, X: np.ndarray, iters: int = KMEANS_ITERS,
           seed: int = KMEANS_SEED):
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(iters):
        a = np.argmin(np.linalg.norm(X[:, None] - C[None], axis=2), axis=1)
        C = np.stack([X[a == j].mean(axis=0) if (a == j).any() else C[j]
                      for j in range(k)])
    return C, a


def silhouette(X: np.ndarray, a: np.ndarray) -> float:
    D = np.linalg.norm(X[:, None] - X[None], axis=2)
    s = []
    for i in range(len(X)):
        own = a == a[i]
        own[i] = False
        if not own.any():
            continue
        ai = D[i][own].mean()
        bi = min(D[i][a == j].mean() for j in set(a) if j != a[i])
        s.append((bi - ai) / max(ai, bi))
    return float(np.mean(s)) if s else -1.0


MIN_ANCHORS = 10        # B2 operated at ~80; k-means over a handful is noise
MIN_SILHOUETTE = 0.35   # B2's accepted clustering scored 0.674


def cluster_kits(anchor_descs: np.ndarray) -> tuple:
    """(centroids, k, silhouette) from the anchor chains' median descriptors.
    Refuses (ValueError) on too few anchors OR a weak silhouette — a garbage
    kit key would silently mis-key EVERY label, so the job must refuse
    labels rather than cluster noise (CV review, 2026-07-18)."""
    if len(anchor_descs) < MIN_ANCHORS:
        raise ValueError(
            f'only {len(anchor_descs)} kit anchor chains — too few to '
            'establish kit clusters')
    best = None
    for k in K_RANGE:
        if k >= len(anchor_descs):
            break
        C, a = kmeans(k, anchor_descs)
        sil = silhouette(anchor_descs, a)
        if best is None or sil > best[2]:
            best = (C, k, sil)
    if best[2] < MIN_SILHOUETTE:
        raise ValueError(
            f'kit clustering unreliable (silhouette {best[2]:.2f} < '
            f'{MIN_SILHOUETTE}) — refusing jersey labels')
    return best


def assign_kit(desc, centroids: np.ndarray) -> int:
    """Nearest-centroid cluster, or -1 beyond OUTLIER_LAB ('other')."""
    if desc is None:
        return -1
    dist = np.linalg.norm(centroids - np.asarray(desc), axis=1)
    j = int(np.argmin(dist))
    return j if dist[j] <= OUTLIER_LAB else -1


def chain_descriptors(records: list) -> dict:
    """{chain: median descriptor} over records carrying a 'kit_desc'."""
    per = defaultdict(list)
    for r in records:
        d = r.get('kit_desc')
        if d is not None:
            per[r['chain']].append(np.asarray(d, float))
    return {c: np.median(np.stack(v), axis=0) for c, v in per.items()}
