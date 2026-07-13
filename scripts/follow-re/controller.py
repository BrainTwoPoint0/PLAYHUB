"""Faithful Python port of the DEPLOYED follow controller
(VirtualPanoramaPlayer.tsx::stepFollow / smoothDamp, lines ~985-1079).

This is the exact lead + critically-damped-spring the product ships. We port it
verbatim so the follow-quality gate is a clean A/B of TARGET SOURCE (motion-
centroid vs ball-driven) through the identical controller — no controller changes.

Two smoothing stages, same as the TSX:
  1. followTarget = EMA of the raw per-frame target  (k=0.35, or 1.0 on first lock)
  2. view = Unity SmoothDamp(view -> followTarget)    (per-axis smoothTime)
FOV follows the action spread: fov = clamp(34 + spread*70, 30, 62).

Coordinate-frame agnostic: pan/tilt/fov are whatever units the caller feeds
(the render-only gate feeds horizontal ball angle in degrees; a raw-pano gate
would feed panorama pan/tilt). smoothTime is in SECONDS, so running at the clip
fps (dt=1/fps) reproduces the deployed 60fps time-domain response.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Deployed constants (VirtualPanoramaPlayer.tsx)
SMOOTH_PAN = 0.5
SMOOTH_TILT = 0.55
SMOOTH_FOV = 1.3
EMA_K = 0.35
FOV_BASE = 34.0
FOV_SPREAD_GAIN = 70.0
FOV_MIN = 30.0
CURVED_FOV_MAX = 62.0


def smooth_damp(cur: float, tgt: float, vel: list, smooth_time: float, dt: float) -> float:
    """Unity SmoothDamp — verbatim from stepFollow (lines 991-1005). vel is a
    1-element mutable list (the JS {v} ref) carried across frames."""
    omega = 2.0 / smooth_time
    x = omega * dt
    exp = 1.0 / (1.0 + x + 0.48 * x * x + 0.235 * x * x * x)
    change = cur - tgt
    temp = (vel[0] + omega * change) * dt
    vel[0] = (vel[0] - omega * temp) * exp
    return tgt + (change + temp) * exp


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


@dataclass
class FollowController:
    """Stateful controller. Feed one raw target per frame via step(); None means
    "no target this frame" (detection miss) -> the view coasts on its spring
    velocity, exactly like the deployed controller when motion energy is gated."""
    fps: float = 30.0
    smooth_pan: float = SMOOTH_PAN
    smooth_tilt: float = SMOOTH_TILT
    smooth_fov: float = SMOOTH_FOV
    ema_k: float = EMA_K
    fov_min: float = FOV_MIN
    fov_max: float = CURVED_FOV_MAX

    view: dict = field(default_factory=lambda: {"pan": 0.0, "tilt": 0.0, "fov": 42.0})
    _ft: dict = field(default_factory=lambda: {"pan": 0.0, "tilt": 0.0, "fov": 42.0})
    _velP: list = field(default_factory=lambda: [0.0])
    _velT: list = field(default_factory=lambda: [0.0])
    _velF: list = field(default_factory=lambda: [0.0])
    _have: bool = False

    def fov_from_spread(self, spread: float) -> float:
        return _clamp(FOV_BASE + spread * FOV_SPREAD_GAIN, self.fov_min, self.fov_max)

    def step(self, target: dict | None) -> dict:
        """target: {'pan','tilt','fov'} (raw) or None. Returns the smoothed view."""
        dt = 1.0 / self.fps
        if target is not None:
            k = self.ema_k if self._have else 1.0
            self._ft["pan"] += (target["pan"] - self._ft["pan"]) * k
            self._ft["tilt"] += (target["tilt"] - self._ft["tilt"]) * k
            fk = 0.08 if self._have else 1.0
            self._ft["fov"] += (target.get("fov", self._ft["fov"]) - self._ft["fov"]) * fk
            self._have = True
        if self._have:
            self.view = {
                "pan": smooth_damp(self.view["pan"], self._ft["pan"], self._velP, self.smooth_pan, dt),
                "tilt": smooth_damp(self.view["tilt"], self._ft["tilt"], self._velT, self.smooth_tilt, dt),
                "fov": smooth_damp(self.view["fov"], self._ft["fov"], self._velF, self.smooth_fov, dt),
            }
        return dict(self.view)


def run(targets: list, fps: float = 30.0, **kw) -> list:
    """Run a whole target sequence through the controller. targets: per-frame
    list of {'pan','tilt','fov'} or None. Returns per-frame smoothed views."""
    ctl = FollowController(fps=fps, **kw)
    return [ctl.step(t) for t in targets]
