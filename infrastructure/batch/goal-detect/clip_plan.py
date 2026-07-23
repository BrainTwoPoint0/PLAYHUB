"""Pure review-clip encode plan (no I/O — unit-tested without boto3/env).

The Supabase project's global storage upload cap is 50MB (measured
2026-07-22: a 60MB POST returns HTTP 400 wrapping a 413 body — this killed
the first pilot job on a 550s-span episode's 648s clip). Every plan bounds
the encode deterministically: duration cap x bitrate ceiling stays under
the wall with container-overhead margin.

Two tiers (AGREED PLAN item 1c, 2026-07-23):

* standard  — full window <= 300s: the original settings, byte-identical
  (300s x 1000kbps ~ 38MB worst case). Banked clips resume-adopt under
  unchanged storage keys.
* extended  — full window > 300s: cap 480s at 700kbps (~42MB worst case),
  so a 550s-span flurry episode keeps its later goals inside the clip
  instead of losing them to the cap (the 00b57031 26:41 miss was the cap
  ending 1.6s before a mega-episode's 3rd goal). Extended clips carry a
  distinct storage-key suffix: a legacy 300s-capped clip banked under the
  old key must never be resume-adopted as a 480s one.

The strip mirrors CLIP_PRE_S / CLIP_POST_S and the 300s legacy cap in
GoalCandidatesStrip.tsx + multi-goal.ts (clip-truncation badge) — keep them
in lockstep.
"""
from __future__ import annotations

from dataclasses import dataclass

CLIP_PRE_S = 90.0    # freeze finding: 45s pre-roll cuts a quarter of caught
CLIP_POST_S = 8.0    # goals out of their own clip; 90s covers the measured
                     # goal->kickoff latency envelope (p90 37s + detection lag)
CLIP_WIDTH = 1280

STD_MAX_S = 300.0
STD_MAXRATE = '1000k'
STD_BUFSIZE = '2000k'

# NOTE: the extended storage-key suffix encodes only the DURATION cap
# (-480s). Changing EXT_MAXRATE/EXT_BUFSIZE alone would resume-adopt
# old-bitrate extended clips under the same key — bump the suffix (via
# EXT_MAX_S or a new tag) if the extended recipe ever changes.
EXT_MAX_S = 480.0
EXT_MAXRATE = '700k'
EXT_BUFSIZE = '1400k'


@dataclass(frozen=True)
class ClipPlan:
    start: float
    dur: float
    maxrate: str
    bufsize: str
    extended: bool


def plan(t0: float, t1: float) -> ClipPlan:
    start = max(0.0, t0 - CLIP_PRE_S)
    window = (t1 - start) + CLIP_POST_S
    if window <= STD_MAX_S:
        return ClipPlan(start, window, STD_MAXRATE, STD_BUFSIZE, False)
    return ClipPlan(start, min(window, EXT_MAX_S), EXT_MAXRATE, EXT_BUFSIZE,
                    True)


def storage_suffix(p: ClipPlan) -> str:
    """Storage-key suffix keeping the two encode tiers resume-separate."""
    return f'-{int(EXT_MAX_S)}s' if p.extended else ''
