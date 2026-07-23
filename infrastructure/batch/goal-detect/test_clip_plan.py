"""clip_plan tests — the adaptive review-clip encode plan.

The plan decides, per episode, the clip window and bitrate ceiling BEFORE
any ffmpeg runs. Two hard requirements:

* short episodes (full window <= 300s) must produce a plan byte-identical
  to the legacy fixed settings — their banked clips are resume-adopted
  under unchanged storage keys, so any drift here silently pairs old clips
  with new metadata;
* every plan's worst-case encode must clear the measured 50MB Supabase
  storage upload cap with margin (the first pilot job died on a 648s clip
  at this exact wall).
"""
import clip_plan


def test_short_episode_matches_legacy_settings():
    # window = (t1 - (t0-90)) + 8 <= 300 -> the pre-adaptive plan, exactly.
    p = clip_plan.plan(1000.0, 1100.0)
    assert p.start == 910.0
    assert p.dur == (1100.0 - 910.0) + 8.0
    assert p.maxrate == '1000k'
    assert p.bufsize == '2000k'
    assert p.extended is False


def test_start_clamps_to_zero_near_kickoff():
    p = clip_plan.plan(30.0, 60.0)
    assert p.start == 0.0
    assert p.dur == 68.0
    assert p.extended is False


def test_boundary_window_exactly_300_stays_standard():
    # start = t0 - 90; window = 90 + (t1-t0) + 8 = 300 => t1-t0 = 202
    p = clip_plan.plan(1000.0, 1202.0)
    assert p.dur == 300.0
    assert p.maxrate == '1000k'
    assert p.extended is False


def test_window_past_300_goes_extended_uncapped_duration():
    # 350s window: fully covered at the lower bitrate (the whole point —
    # the 00b57031 26:41 goal sat 1.6s past the old 300s cap).
    p = clip_plan.plan(1000.0, 1252.0)  # window = 90 + 252 + 8 = 350
    assert p.extended is True
    assert p.dur == 350.0
    assert p.maxrate == '700k'
    assert p.bufsize == '1400k'


def test_extended_window_caps_at_480():
    p = clip_plan.plan(1000.0, 1700.0)  # window = 798
    assert p.extended is True
    assert p.dur == 480.0


def test_worst_case_size_clears_upload_cap_with_margin():
    # Deterministic bound: dur * maxrate / 8 must stay under 45MB (10%
    # container-overhead headroom below the 50MB wall) for ANY span.
    for span in (10, 100, 202, 203, 300, 382, 500, 1000, 5000):
        p = clip_plan.plan(1000.0, 1000.0 + span)
        rate_bps = int(p.maxrate.rstrip('k')) * 1000
        assert p.dur * rate_bps / 8 <= 45_000_000, span


def test_storage_suffix_separates_extended_epoch():
    # Extended clips key differently: a legacy 300s-capped clip banked under
    # the unsuffixed key must never be resume-adopted as a 480s one.
    assert clip_plan.storage_suffix(clip_plan.plan(1000.0, 1100.0)) == ''
    assert clip_plan.storage_suffix(clip_plan.plan(1000.0, 1700.0)) == '-480s'


def test_duration_never_shrinks_when_episode_grows():
    prev = 0.0
    for span in range(0, 800, 7):
        p = clip_plan.plan(1000.0, 1000.0 + span)
        assert p.dur >= prev
        prev = p.dur
