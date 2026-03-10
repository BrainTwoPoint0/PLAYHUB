# PLAYBACK Engine v2 — AutoFollow Content Pipeline

**Version:** 2.3 | **Date:** March 2026 | **Author:** Karim Fawaz, Founder & CEO
**Classification:** Internal / Engineering
**Supersedes:** v2.2 (pre-validation, referenced deprecated Gemini 2.5 Flash)

---

## 1. Why This Version Exists

v2.0 assumed we'd build full CV event detection from scratch. The reality is simpler:

**Spiideo gives us raw 4K panoramic footage with zero event tags.** Their AutoData (manual tagging) is expensive and slow. These recordings benefit the most from automated event detection + portrait conversion. This is where the Engine creates real value.

**Veo already solves its own problem.** Veo tags games with goals, shots, set pieces, fouls, corners — all free. Veo recordings are already directed (AutoFollow). We don't need to tag or convert them. They're useful as a **source of goal clips to convert to portrait for PLAYBACK's social media**, but they're not the core Engine product.

**The gap nobody fills at grassroots level: landscape → portrait auto-crop with ball tracking.** Every recording is 16:9. Social media is 9:16. Clubs manually crop or just post letterboxed. WSC Sports does this for the Bundesliga and La Liga, but at six-figure enterprise pricing. We can build this as a paid PLAYHUB service — particularly powerful on Spiideo's high-res 4K panoramic footage.

```
What exists today:
[Spiideo 4K panoramic] → [Raw recording on PLAYHUB] → No tags, no portrait, nothing
[Veo AutoFollow]        → [Tagged recording on PLAYHUB] → Tags exist but clips aren't used

What we're building:
[Spiideo 4K] → [PLAYBACK Engine] → [AI event tags + Portrait crop + Branded clips]
                                              │
                                    Primary product — paid service
                                    for PLAYHUB recording owners

[Veo clips] → [Grab goal clips] → [Portrait convert] → [PLAYBACK social media content]
                                              │
                                    Internal use — fuel PLAYBACK's
                                    own social channels
```

### Business Model

This is a **paid optional service** for organizations and users who already have or purchased recordings on PLAYHUB:

- Organization buys/has recordings on PLAYHUB
- Opts into Engine processing (per-recording or subscription)
- Gets: portrait-format clips, event-tagged highlights, branded exports
- Downloads and posts to their own social channels

Revenue is incremental on existing PLAYHUB transactions — not a separate product.

---

## 2. What We Already Have (Don't Rebuild)

### 2.1 Veo Event Data (Available, Low Priority)

Veo already tags games with goals, shots, corners, fouls, offsides. Our scraper currently ignores this data — it only pulls title/duration/privacy/thumbnail.

**Not the priority for the Engine.** Veo recordings already have tags and directed footage. The main Engine use case for Veo content is grabbing goal clips and converting them to portrait for PLAYBACK's own social media — a simpler pipeline.

**Nice-to-have:** Extend the scraper to pull Veo event tags and store in `playhub_recording_events`. This enriches the PLAYHUB recording detail page but doesn't drive Engine revenue.

### 2.2 Graphic Packages (Fully Built)

The `playhub_graphic_packages` system is production-ready:

| Feature                               | Status   |
| ------------------------------------- | -------- |
| Org-level logo + sponsor logo         | ✅ Built |
| 4-position placement (corners)        | ✅ Built |
| Default auto-attach to recordings     | ✅ Built |
| Spiideo package import                | ✅ Built |
| Supabase Storage (PNG/JPEG/WebP, 5MB) | ✅ Built |
| CSS overlay on video player           | ✅ Built |

**For the Engine:** Instead of CSS overlay (browser-only), burn logos into exported clips via FFmpeg. The graphic package data (logo URLs, positions) is already queryable per recording.

### 2.3 Recording Events Table (Schema Ready)

```typescript
// Already exists in PLAYHUB
interface RecordingEvent {
  id: string
  match_recording_id: string
  event_type:
    | 'goal'
    | 'shot'
    | 'save'
    | 'corner'
    | 'free_kick'
    | 'yellow_card'
    | 'red_card'
    | 'penalty'
    | 'kick_off'
    | 'half_time'
    | 'full_time'
    | 'foul'
    | 'substitution'
    | 'other'
  timestamp_seconds: number
  team: 'home' | 'away' | null
  label: string | null
  source: 'manual' | 'ai_detected'
  confidence_score: number | null
  visibility: 'public' | 'private'
}
```

Manual tagging API already exists at `/api/recordings/[id]/events`. AI-detected events just need `source: 'ai_detected'`.

### 2.4 AWS Infrastructure (Shared)

Same account (`274921264686`, `eu-west-2`). S3 buckets, Lambda infrastructure, and IAM roles already in place. Engine clips go under a new S3 prefix — no new account setup needed.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     PLAYBACK ENGINE v2                           │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    INPUT LAYER                             │  │
│  │                                                            │  │
│  │  PRIMARY:                                                  │  │
│  │  [Spiideo 4K panoramic] → Gemini 3 event detection          │  │
│  │                          → Portrait conversion             │  │
│  │  [Direct uploads]       → Gemini 3 event detection          │  │
│  │                          → Portrait conversion             │  │
│  │                                                            │  │
│  │  SECONDARY (PLAYBACK social media):                        │  │
│  │  [Veo goal clips] → Portrait conversion only               │  │
│  │                     (events already tagged by Veo)          │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                              │                                   │
│  ┌──────────────────────────▼────────────────────────────────┐  │
│  │              PORTRAIT CONVERSION (Core Product)            │  │
│  │                                                            │  │
│  │  [16:9 recording] → [YOLO ball detection] → [ByteTrack]   │  │
│  │                      [action area tracking]                │  │
│  │                      [smooth crop window]                  │  │
│  │                      → [FFmpeg 9:16 extraction]            │  │
│  │                                                            │  │
│  │  Output: Portrait video following the action               │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                              │                                   │
│  ┌──────────────────────────▼────────────────────────────────┐  │
│  │                    CLIP ENGINE                             │  │
│  │                                                            │  │
│  │  [Events + Portrait] → [FFmpeg clip extraction]            │  │
│  │                         [+ brand overlay burn-in]          │  │
│  │                         [+ format variants]                │  │
│  │                                                            │  │
│  │  Outputs:                                                  │  │
│  │    - Full match portrait (9:16)                            │  │
│  │    - Highlight reel (60-90s, top events by excitement)     │  │
│  │    - Individual event clips (goal, save, etc.)             │  │
│  │    - Branded with org's graphic package                    │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                              │                                   │
│  ┌──────────────────────────▼────────────────────────────────┐  │
│  │                  DELIVERY                                  │  │
│  │                                                            │  │
│  │  [Clips] → [PLAYHUB library]  Download / embed             │  │
│  │         → [Partner dashboard] Browse events, pick clips    │  │
│  │         → [PLAYBACK profiles] Import as highlights          │  │
│  │                                                            │  │
│  │  Phase 2: Social auto-publish (Instagram, TikTok, YouTube) │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Service Stack

| Component                             | Technology                        | Why                                                            |
| ------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| **Event Detection (Spiideo/uploads)** | Gemini 3 Flash API (Batch)        | Only major LLM with native video input, no GPU needed          |
| **Veo goal clips (secondary)**        | Veo API (already tagged)          | Free, just portrait-convert for social                         |
| **Portrait Conversion (test first)**  | Cloudinary `g_auto` / OpusClip    | Test ready-made before building custom                         |
| **Portrait Conversion (custom)**      | FootAndBall + ByteTrack           | 0.909 AP on long-shot cameras (better than YOLO for panoramic) |
| **Video Processing**                  | FFmpeg on Lambda                  | Burst workload, pay-per-use, existing infra                    |
| **Job Queue**                         | SQS (or existing Lambda triggers) | Already have Lambda infra, no Redis needed                     |
| **Storage**                           | S3 (existing bucket, new prefix)  | Same account, no new setup                                     |
| **Database**                          | Supabase (existing)               | Events table already exists                                    |
| **Deployment**                        | Lambda (FFmpeg) + EC2 spot (GPU)  | Lambda for clips, GPU only for portrait crop                   |

---

## 4. Portrait Conversion — Technical Specification

This is the core differentiator. WSC Sports charges enterprise pricing for this. We build it as a self-hosted pipeline.

### 4.1 Problem Definition

Given a 16:9 landscape football recording, produce a 9:16 portrait version where the crop window automatically follows the ball and action area with smooth, broadcast-like camera movement.

**Critical challenge for Spiideo footage:** The ball is 8-16 pixels wide in raw 4K panoramic frames. It's invisible in 30-65% of frames (behind players, in scrums, off-screen). All three companies that solve this (Spiideo, Veo, Pixellot) use a hybrid approach: track ball when visible, fall back to player cluster centroid when it's not. We must do the same.

### 4.2 "Test First" Alternatives

Before building a custom pipeline, test these ready-made options:

| Option                  | What It Does                                         | Cost                                 | Worth Testing?               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------ | ---------------------------- |
| **Cloudinary `g_auto`** | AI auto-crop on video, content-aware                 | ~$0.40/min (video transform pricing) | **Yes — test first**         |
| **OpusClip**            | Claims ball tracking + auto-crop for sports, has API | Unknown (startup pricing)            | **Yes — request API access** |

If Cloudinary's `g_auto` produces acceptable quality on a few sample recordings, it could replace the entire custom pipeline. Test on 3-5 Spiideo recordings before committing to self-hosted.

### 4.3 Custom Pipeline (If Ready-Made Fails)

```
Step 1: Ball Detection (FootAndBall or YOLO v11)
  - FootAndBall: Purpose-built for long-shot static cameras (8-16px balls)
    - 0.909 AP on ISSIA-CNR dataset (wide-angle sports footage)
    - Better starting point than generic YOLO for panoramic
  - YOLO v11: Use with SAHI tiling (split 4K frame into 2x2 grid)
    - 0.85-0.90 AP on panoramic with tiling (NOT 0.925 — that's broadcast-only)
    - Generic YOLO without tiling: 0.60-0.70 AP on panoramic (ball too small)
  - Run at 10-15 fps
  - Also detect players for action area estimation

Step 2: Multi-Object Tracking (ByteTrack)
  - Consistent ball tracking across frames
  - Handle occlusions and disappearances (30-65% of frames!)
  - MANDATORY fallback to player cluster centroid when ball is lost

Step 3: Crop Window Computation
  - Primary: ball position (when detected with high confidence)
  - Fallback 1: player cluster centroid (when ball lost)
  - Fallback 2: hold position (during stoppages, no motion)
  - Apply temporal smoothing (exponential moving average)
  - Constrain: no sudden jumps, max pan speed, stay within frame bounds
  - Crop aspect ratio: 9:16 from 16:9 source

Step 4: FFmpeg Extraction
  - Apply computed crop coordinates per frame
  - Output 1080x1920 portrait video
  - Preserve audio
  - H.264 encoding, AAC audio
```

**Key difference from v2.1:** The ball is NOT reliably detectable in panoramic footage. The "0.925 mAP" figure cited in v2.1 is for broadcast cameras (close-up, TV-quality). On Spiideo's wide-angle static cameras:

| Scenario                   | Ball Detection AP | Notes                              |
| -------------------------- | ----------------- | ---------------------------------- |
| Broadcast (TV camera)      | 0.92-0.95         | Close-up, ball is 30-50px          |
| Panoramic with SAHI tiling | 0.85-0.90         | Ball is 8-16px, tiling helps       |
| Panoramic without tiling   | 0.60-0.70         | Ball too small, many misses        |
| Ball not visible at all    | 30-65% of frames  | Behind players, scrums, off-screen |

**Recommended model stack:**

1. **Start with FootAndBall** — specifically designed for long-shot sports footage, proven on wide-angle cameras
2. **If FootAndBall underperforms**, try YOLO v11 with SAHI (Slicing Aided Hyper Inference) — splits 4K frame into overlapping tiles, runs detection per tile, merges results
3. **Never use generic YOLO without tiling** on panoramic footage — will miss most balls

### 4.4 Smooth Camera Logic

```python
class SmartCrop:
    def __init__(self, frame_width, frame_height, smoothing=0.05):
        self.crop_w = int(frame_height * 9 / 16)  # Portrait width from landscape
        self.crop_h = frame_height
        self.smoothing = smoothing  # Lower = smoother
        self.current_x = frame_width // 2  # Start centered
        self.ball_lost_frames = 0

    def update(self, ball_x, ball_y, confidence, players):
        if ball_x is not None and confidence > 0.5:
            target_x = ball_x
            self.ball_lost_frames = 0
        elif players:
            self.ball_lost_frames += 1
            # Fallback: center of player cluster (weighted by proximity to last known ball)
            target_x = sum(p.center_x for p in players) / len(players)
        else:
            self.ball_lost_frames += 1
            target_x = self.current_x  # Hold position

        # Use slower smoothing when ball is lost (less jumpy)
        smooth = self.smoothing if self.ball_lost_frames == 0 else self.smoothing * 0.5

        # Exponential smoothing (prevents jarring movement)
        self.current_x += (target_x - self.current_x) * smooth

        # Clamp to frame bounds
        half_w = self.crop_w // 2
        self.current_x = max(half_w, min(self.frame_width - half_w, self.current_x))

        return int(self.current_x - half_w), 0  # crop x, y
```

### 4.5 Hardware & Cost

| Config                             | Throughput            | Monthly Cost (500 matches/week) |
| ---------------------------------- | --------------------- | ------------------------------- |
| EC2 g5.xlarge spot (1x A10G)       | ~3-5 matches/hour     | ~$255/month                     |
| 2x g5.xlarge spot instances        | ~6-10 matches/hour    | ~$510/month                     |
| Lambda (FFmpeg clip assembly only) | Burst, per-invocation | ~$50-100/month                  |

At 500 matches/week ≈ 72 matches/day, a single g5.xlarge spot instance handles the load comfortably (~24 matches in an 8-hour window).

---

## 5. Event Detection — Spiideo & Direct Uploads

### 5.1 Primary Target: Spiideo Raw 4K Panoramic

Spiideo recordings have zero event tags (AutoData is manual and expensive). These benefit the most from AI event detection. The raw 4K panoramic footage gives us more visual information to work with than directed footage.

### 5.2 Gemini 3 Flash (Primary Model)

For all recordings that need event detection, use Gemini 3 Flash. **It is the only major LLM with native video input via API** — Claude and GPT-4o do not accept video files.

> **⚠️ VALIDATION REQUIRED — This is an untested bet.**
> No published case study exists of Gemini being used for full 90-min match event detection in production. The SportU benchmark (Oct 2024, tested on Gemini 1.5) scored ~65% on sports video understanding. Gemini 3 is a significant upgrade (15% improvement on vision tasks, 87.6% on Video-MMMU), but nobody has validated it on panoramic grassroots football footage specifically. **We must test on 5 real Spiideo recordings in Week 1 before committing.**

**Gemini 3 Flash specs (March 2026):**

- Native video understanding (upload MP4, get structured JSON)
- 15% accuracy improvement over 2.5 Flash on vision tasks
- "Agentic Vision" capability for real-time video analysis
- 1M token context window: ~63 minutes at default resolution, ~166 minutes at low resolution mode
- A 90-min match at low resolution ≈ 540K tokens
- **2GB max file upload** — 4K Spiideo footage must be transcoded to 720p before upload
- FPS is configurable — default 1 FPS, can increase for sports (higher FPS = more tokens = more cost)
- **End-to-end latency: 15-45 minutes per match** (upload + processing + response)

**Cost estimates (to be validated — Gemini 3 Flash pricing may differ from 2.5):**

- Gemini 2.5 Flash pricing: ~$0.17/match at low resolution via Batch API
- Gemini 3 Flash may be similar or lower (Google typically prices Flash models aggressively)
- At 500 matches/week with Batch API: estimated ~$340-680/month

**Known issues to test for:**

- **Timestamp drift on long videos** — Multiple forum reports of timestamps ending at 17 min for 30 min videos. Documented on [Google AI Forum](https://discuss.ai.google.dev/t/improve-timestamp-accuracy-on-video-understanding/95356). Uploading files directly (not YouTube URLs) produces better timestamps. May need to chunk 90-min matches into 15-min segments.
- **1 FPS default sampling** — Events shorter than ~1 second may not register. Can increase FPS but at higher token cost. For grassroots football, most key events (goals, cards, corners) last several seconds — fast deflections and quick free kicks may be missed.
- **Panoramic footage at low resolution** — Compressing 4K panoramic to 720p means Gemini sees player blobs, not individuals. May struggle to distinguish teams or identify specific event types.
- **No sports-specific benchmark exists for Gemini 3** — we're extrapolating from general vision improvements.

**Fallback plan if Gemini validation fails:**

1. **Chunk the video** — Split 90-min match into 6x15-min segments, process each separately, merge events. This may fix timestamp drift and improve detail.
2. **Increase resolution** — Use default resolution instead of low (~$0.45/match instead of $0.17). More detail, still cheaper than alternatives.
3. **T-DEED (SoccerNet winner)** — Traditional CV model, best-in-class for action spotting. Requires GPU + fine-tuning on our footage, but proven at [SoccerNet 2025](https://arxiv.org/html/2508.19182v1). More engineering effort but no timestamp issues.
4. **Hybrid approach** — Use Gemini for coarse event detection (goals, halftime, cards), then run a lightweight CV model on the flagged segments for precise timestamps.

**Prompt strategy:**

```
Analyze this football match recording. For each significant event, provide:
- timestamp (seconds from start)
- event_type: goal | shot_on_target | save | corner | free_kick |
  yellow_card | red_card | penalty | kick_off | half_time | full_time | foul
- team: home | away (if determinable)
- confidence: 0.0-1.0
- excitement: 1-5

Respond as JSON array. Only include events with confidence > 0.7.
```

**Why not other LLMs:**

- **Claude (Anthropic)**: No native video input API — would need frame extraction + image sequence, much more expensive
- **GPT-4o (OpenAI)**: No native video input API — same limitation
- **Twelve Labs**: Good for semantic video search but $3+/match and overkill for event detection

**Compared to v2.0's plan:**

- v2.0: Train ResNet50 → SlowFast → custom pipeline ($500 bootstrapping + $400/month GPU + months of engineering)
- v2.3: Call Gemini 3 Flash API (estimated ~$340-680/month, ships in a day, but requires validation on our footage first)

### 5.3 Excitement Scoring

Same logic as v2.0 — computed after events are detected, regardless of source:

```python
base_scores = {
    'goal': 5.0, 'penalty': 4.5, 'red_card': 4.0,
    'save': 3.5, 'shot_on_target': 3.0, 'near_miss': 3.5,
    'yellow_card': 2.0, 'free_kick': 2.0, 'corner': 1.5,
}

# Context multipliers
# Late game (last 10 min): ×1.3
# Close game (1-goal diff): ×1.2
# Equalizer goal: ×1.5
```

---

## 6. Clip Generation Engine

### 6.1 Runs on Lambda (Not ECS)

Clip generation is a burst workload — process a batch, done. Lambda with FFmpeg layer is cheaper and simpler than always-on ECS.

```
Lambda: playback-engine-clip-generator
  Runtime: Node.js 20 or Python 3.12
  Memory: 3008 MB (max for FFmpeg)
  Timeout: 15 minutes
  Storage: 10 GB ephemeral (/tmp)
  Layer: FFmpeg binary layer
  Trigger: SQS queue or direct invoke from analysis step
```

### 6.2 Highlight Reel Assembly

```python
def generate_highlight_reel(events, source_video, target_duration=75):
    # Sort by excitement, take top events that fit
    ranked = sorted(events, key=lambda e: e.excitement, reverse=True)

    selected = []
    total = 0
    for event in ranked:
        clip_len = get_clip_duration(event)  # 8-15s per event
        if total + clip_len <= target_duration:
            selected.append(event)
            total += clip_len

    # Re-sort chronologically
    selected.sort(key=lambda e: e.timestamp)

    # Extract and concatenate with crossfade
    clips = []
    for event in selected:
        pre_roll = 4
        post_roll = 10 if event.type == 'goal' else 6
        clips.append({
            'start': max(0, event.timestamp - pre_roll),
            'end': event.timestamp + post_roll,
        })

    # FFmpeg: extract, crossfade, overlay brand
    return assemble_with_ffmpeg(source_video, clips, brand_overlay)
```

### 6.3 Brand Overlay Burn-in

Uses existing `playhub_graphic_packages` data — no new system needed:

```python
def get_brand_overlay(recording_id):
    # Same fallback chain as PLAYHUB video player:
    # 1. Recording's assigned graphic_package_id
    # 2. Org's default package (is_default=true)
    # 3. No overlay

    package = fetch_graphic_package(recording_id)
    if not package:
        return None

    return {
        'logo_url': package.logo_url,           # Already in Supabase Storage
        'logo_position': package.logo_position,  # top-left, top-right, etc.
        'sponsor_url': package.sponsor_logo_url,
        'sponsor_position': package.sponsor_position,
    }

# FFmpeg overlay filter:
# ffmpeg -i input.mp4 -i logo.png -filter_complex "overlay=x:y" output.mp4
```

### 6.4 Output Formats

| Format                       | Specs                   | Use Case                             |
| ---------------------------- | ----------------------- | ------------------------------------ |
| **Portrait full match**      | 1080x1920, 9:16, H.264  | Full game in portrait (core product) |
| **Portrait highlight reel**  | 1080x1920, 9:16, 60-90s | Social-ready highlight package       |
| **Individual event clips**   | 1080x1920, 9:16, 8-15s  | Goal clip, save clip, etc.           |
| **Landscape highlight reel** | 1920x1080, 16:9, 60-90s | YouTube, website embed               |
| **Thumbnail**                | 1280x720, JPEG          | Preview image for PLAYHUB listing    |

---

## 7. Delivery

### 7.1 Phase 1: Download from PLAYHUB

No social auto-publish. Partners download clips and post themselves.

```
PLAYHUB Recording Detail Page:
┌──────────────────────────────────────────────┐
│  CFA U14 vs City FC  |  3-1  |  15 Feb 2026 │
│                                               │
│  📹 Recording  |  🎬 Engine Clips            │
│                                               │
│  ┌────────────┐  ┌────────────┐              │
│  │ [portrait] │  │ [portrait] │              │
│  │ Full Match │  │ Highlights │              │
│  │ 9:16       │  │ 75s, 9:16  │              │
│  │ [Download] │  │ [Download] │              │
│  └────────────┘  └────────────┘              │
│                                               │
│  Event Clips:                                 │
│  ⚽ Goal 23:41 (home) ★★★★★  [Download]      │
│  ⚽ Goal 45:02 (away) ★★★★☆  [Download]      │
│  🟨 Save 67:15 (away) ★★★☆☆  [Download]      │
│  ⚽ Goal 89:30 (home) ★★★★★  [Download]      │
│                                               │
│  All clips include CFA branding               │
└──────────────────────────────────────────────┘
```

### 7.2 Phase 2: Social Auto-Publish (Future)

Instagram Graph API, TikTok Content Posting API, YouTube Data API. Requires app review and business verification — weeks of bureaucratic lead time. Build only after Phase 1 proves clips are worth posting.

### 7.3 PLAYBACK Profile Integration

Engine clips can be imported as profile highlights via the existing `importRecordingAsHighlight` action. The video resolution API (`/api/highlights/[id]/video`) already handles S3 signed URLs.

---

## 8. Data Architecture

### 8.1 Supabase Schema (Extends Existing)

The `playhub_recording_events` table already exists. We add two tables:

```sql
-- Engine processing jobs (one per recording)
CREATE TABLE playback_engine_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_recording_id UUID REFERENCES playhub_match_recordings(id),

    -- Job config
    requested_by UUID REFERENCES auth.users(id),
    job_type TEXT CHECK (job_type IN ('portrait_only', 'events_only', 'full')),

    -- Status
    status TEXT CHECK (status IN ('queued', 'processing', 'completed', 'failed')),

    -- Results
    events_detected INTEGER,
    clips_generated INTEGER,
    portrait_url TEXT,          -- S3 path to portrait full match
    processing_time_seconds FLOAT,
    model_version TEXT,         -- 'gemini-3-flash' or 'veo-native'
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Generated clips (multiple per job)
CREATE TABLE playback_engine_clips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES playback_engine_jobs(id),
    match_recording_id UUID REFERENCES playhub_match_recordings(id),

    clip_type TEXT CHECK (clip_type IN (
        'portrait_full', 'highlight_reel', 'event_clip'
    )),
    event_type TEXT,               -- 'goal', 'save', etc. (NULL for reel/full)
    event_timestamp FLOAT,
    excitement_score FLOAT,
    duration_seconds FLOAT,

    -- Storage
    s3_key TEXT NOT NULL,
    s3_bucket TEXT NOT NULL,
    thumbnail_s3_key TEXT,

    -- Overlay applied
    graphic_package_id UUID REFERENCES playhub_graphic_packages(id),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_engine_jobs_recording ON playback_engine_jobs(match_recording_id);
CREATE INDEX idx_engine_jobs_status ON playback_engine_jobs(status);
CREATE INDEX idx_engine_clips_job ON playback_engine_clips(job_id);
CREATE INDEX idx_engine_clips_recording ON playback_engine_clips(match_recording_id);
```

### 8.2 S3 Storage

```
playhub-recordings/          (existing bucket)
  └── engine/
      └── {match_id}/
          ├── portrait_full.mp4
          ├── highlight_reel_9x16.mp4
          ├── highlight_reel_16x9.mp4
          ├── events/
          │   ├── goal_1_9x16.mp4
          │   ├── goal_2_9x16.mp4
          │   ├── save_1_9x16.mp4
          │   └── ...
          └── thumbnails/
              ├── highlight_thumb.jpg
              ├── goal_1_thumb.jpg
              └── ...
```

---

## 9. Deployment

```
┌──────────────────────────────────────────┐
│            AWS (eu-west-2)               │
│         Same account as PLAYHUB          │
│                                          │
│  ┌────────────────┐  ┌───────────────┐  │
│  │ Lambda          │  │ EC2 Spot      │  │
│  │                 │  │ (g5.xlarge)   │  │
│  │ Clip Generator  │  │               │  │
│  │ (FFmpeg layer)  │  │ Portrait      │  │
│  │                 │  │ Converter     │  │
│  │ Gemini API      │  │ (YOLO +       │  │
│  │ calls           │  │  ByteTrack)   │  │
│  │                 │  │               │  │
│  │ Veo tag sync    │  │ Runs only     │  │
│  │                 │  │ when jobs      │  │
│  │                 │  │ are queued     │  │
│  └───────┬────────┘  └──────┬────────┘  │
│          │                   │           │
│  ┌───────▼───────────────────▼────────┐  │
│  │         SQS (Job queue)            │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │ S3 (existing) │  │ Supabase        │  │
│  │ engine/ prefix│  │ (existing DB)   │  │
│  └──────────────┘  └─────────────────┘  │
└──────────────────────────────────────────┘

Monthly Cost Estimate (500 matches/week):
├── EC2 Spot g5.xlarge (~20hrs/week): ~£255/mo
├── Lambda (clip assembly): ~£50-100/mo
├── Gemini 3 Flash Batch API: ~£270/mo (estimated, pricing TBC)
├── S3 storage: ~£20/mo
├── SQS: ~£5/mo
└── TOTAL: ~£600-650/mo (custom portrait)
    OR: ~£400-500/mo (if Cloudinary g_auto works, no EC2 needed)
```

---

## 10. Build Plan — 5 Weeks to First Clips

### Week 1: Validation Sprint (CRITICAL — test before building)

- [ ] **Test Gemini 3 Flash** on 5 Spiideo recordings:
  - Transcode 4K→720p, upload to Gemini, run event detection prompt
  - Measure: event recall, timestamp accuracy, drift on 90-min matches
  - Try chunked (6×15 min) vs full upload — compare timestamp quality
  - Try higher FPS (2-5 FPS) vs default 1 FPS
  - **Go/no-go decision on Gemini for event detection**
- [ ] **Test Cloudinary `g_auto`** on 3-5 Spiideo recordings (portrait conversion quality)
- [ ] **Request OpusClip API access** and evaluate if available
- [ ] Create `playback_engine_jobs` and `playback_engine_clips` tables
- [ ] S3 prefix `engine/` under existing bucket
- [ ] Build 4K→720p transcode step (FFmpeg Lambda)
- [ ] **Decision gate:** Gemini vs T-DEED for events, Cloudinary vs custom for portrait

### Week 2: Gemini 3 Flash Event Detection on Spiideo

- [ ] Gemini 3 Flash event detection pipeline (Batch API)
- [ ] Handle: transcode → upload to Gemini 3 → parse JSON response → store events
- [ ] Test on 5-10 Spiideo recordings — verify event accuracy and timestamps
- [ ] Store results in `playhub_recording_events` (source: 'ai_detected')
- [ ] Measure: accuracy, missed events, timestamp precision

### Week 3: Portrait Conversion Pipeline

- [ ] **If Cloudinary works:** integrate `g_auto` API for portrait conversion
- [ ] **If custom needed:** FootAndBall + ByteTrack on EC2 g5 spot
- [ ] SmartCrop algorithm with hybrid tracking (ball + player cluster fallback)
- [ ] FFmpeg 9:16 extraction with computed crop coordinates
- [ ] Test on 5 CFA recordings — evaluate smoothness and ball-follow accuracy
- [ ] Lambda function for FFmpeg clip assembly (separate from GPU work)

### Week 4: Clip Engine + Brand Overlays

- [ ] Highlight reel assembly (top events by excitement, crossfade)
- [ ] Individual event clip extraction
- [ ] Brand overlay burn-in using existing graphic packages
- [ ] Thumbnail generation (key frame extraction)
- [ ] Upload to S3, update Supabase tables

### Week 5: PLAYHUB Integration + Pilot

- [ ] PLAYHUB API: trigger Engine processing for a recording
- [ ] PLAYHUB UI: "Engine Clips" tab on recording detail page
- [ ] Download links for all generated clips
- [ ] End-to-end test: Spiideo recording → events → portrait → clips → download
- [ ] Run on 20 real CFA matches
- [ ] Review output quality, fix critical issues
- [ ] **Ship to CFA as first partner**

### Post-Launch (Weeks 6-8):

- [ ] Gemini 3 Flash event detection tuning (prompt refinement, edge cases)
- [ ] Portrait quality improvements (smoothing, edge-case handling)
- [ ] Pricing/billing integration (per-recording or subscription)
- [ ] Engagement tracking (downloads, views per clip)
- [ ] Veo goal clip → portrait pipeline (secondary, for PLAYBACK social media)
- [ ] Social auto-publish API integration (Instagram, TikTok — Phase 2)

---

## 11. Success Metrics

| Metric                            | Week 4 (Launch)        | Month 3    | Month 6    |
| --------------------------------- | ---------------------- | ---------- | ---------- |
| Recordings processed              | 20                     | 200/week   | 500/week   |
| Portrait conversions              | 20                     | 200/week   | 500/week   |
| Clips generated                   | 100                    | 1,000/week | 5,000/week |
| Event detection accuracy (Veo)    | Use Veo's own accuracy | Same       | Same       |
| Event detection accuracy (Gemini) | >80%                   | >85%       | >90%       |
| Time: recording → clips ready     | <60 min                | <30 min    | <20 min    |
| Partner orgs using                | 1 (CFA)                | 5          | 15+        |

---

## 12. Cost Comparison

| Approach                      | Monthly Cost        | Clips/Month | Cost/Clip  |
| ----------------------------- | ------------------- | ----------- | ---------- |
| **WSC Sports (enterprise)**   | ~£50,000-200,000/yr | Unlimited   | N/A        |
| **Spiideo AutoData (manual)** | ~£2,000-5,000       | ~200        | £10-25     |
| **Hire a video editor**       | ~£3,000+            | ~100-200    | £15-30     |
| **PLAYBACK Engine**           | ~£400-650           | 4,000+      | £0.10-0.15 |

---

## 13. What We DON'T Build in Phase 1

| Feature                     | Why Not Yet                                          | When                                  |
| --------------------------- | ---------------------------------------------------- | ------------------------------------- |
| Social auto-publish         | Requires platform app review + business verification | Phase 2                               |
| Player identification       | Needs annotation investment + panoramic footage      | Phase 3                               |
| "My Child" player clips     | Needs player tracking first                          | Phase 3                               |
| WhatsApp parent delivery    | Needs player-level clips                             | Phase 3                               |
| Tactical analysis           | Needs full-pitch view + formation detection          | Phase 3                               |
| AI commentary / voiceover   | Nice-to-have, not core                               | Phase 3                               |
| Real-time (live) processing | Post-match is fine for grassroots                    | Never (or Phase 4)                    |
| Custom CV model training    | Gemini 3 Flash + FootAndBall is cheaper if validated | Only if API approach fails validation |

---

## 14. Technical Research Findings (March 2026)

This section documents verified research to avoid building on wrong assumptions.

### 14.1 Event Detection — Model Comparison

| Option                 | Cost/Match        | Native Video?         | Proven on Sports?                 | Infra                       |
| ---------------------- | ----------------- | --------------------- | --------------------------------- | --------------------------- |
| **Veo built-in tags**  | $0                | N/A                   | Yes (Veo's own system)            | None — just pull data       |
| **Gemini 3 Flash**     | TBC (~$0.17 est.) | **Yes**               | **No — untested on full matches** | None — API call             |
| **SoccerNet T-DEED**   | ~$0.10 (GPU)      | N/A (custom CV)       | **Yes — SoccerNet 2025 winner**   | EC2 GPU + fine-tuning       |
| **Claude (Anthropic)** | N/A               | **No** — no video API | N/A                               | Would need frame extraction |
| **GPT-4o (OpenAI)**    | N/A               | **No** — no video API | N/A                               | Would need frame extraction |
| **Twelve Labs**        | ~$3.00            | Yes                   | Unknown                           | API call                    |

**Decision:** Test Gemini 3 Flash first (simplest to try — it's an API call). If timestamp drift or accuracy is unacceptable on our footage, fall back to T-DEED (proven on SoccerNet, but requires more engineering).

**Key caveat: No production evidence exists for Gemini on full-match event detection.** The best evidence is:

- SportU benchmark: ~65% accuracy (Gemini 1.5 Pro, Oct 2024). Gemini 3 is newer but no sports benchmark published.
- Hobby projects ([Hylytr](https://ai.google.dev/competition/projects/hylytr), [FootballVideoAnalyst](https://github.com/yYorky/FootballVideoAnalyst)) demo feasibility on highlight clips, not full matches.
- Timestamp drift documented on [Google AI Forum](https://discuss.ai.google.dev/t/improve-timestamp-accuracy-on-video-understanding/95356) — still open as of 2026.
- SoccerNet 2025 winning models all use traditional CV (T-DEED), not LLMs.

**Gemini caveats to plan for:**

- 2GB file upload limit → must transcode 4K Spiideo footage to 720p before upload
- 1 FPS default sampling (configurable) → fast events may be missed
- Timestamp accuracy ±2-5 seconds, worse on long videos → may need video chunking
- Upload + processing latency: 15-45 minutes per match
- Compressed panoramic footage loses detail → Gemini sees player blobs, not faces

### 14.2 Ball Detection — Panoramic vs Broadcast Reality

**The "0.925 mAP" figure is misleading.** That's for broadcast cameras (close-up, TV-quality, ball is 30-50px). On Spiideo's static panoramic cameras, the ball is 8-16 pixels wide and invisible 30-65% of the time.

| Scenario                | Ball AP          | Ball Size | Notes                                        |
| ----------------------- | ---------------- | --------- | -------------------------------------------- |
| Broadcast (TV camera)   | 0.92-0.95        | 30-50px   | Close-up, well-lit                           |
| Panoramic + SAHI tiling | 0.85-0.90        | 8-16px    | Tiling splits frame into overlapping regions |
| Panoramic, no tiling    | 0.60-0.70        | 8-16px    | Ball too small for standard detection        |
| Ball not visible        | 30-65% of frames | N/A       | Behind players, in scrums, off-screen        |

**Best models for our use case:**

| Model                   | Designed For               | Ball AP (long-shot)    | Notes                                       |
| ----------------------- | -------------------------- | ---------------------- | ------------------------------------------- |
| **FootAndBall**         | Long-shot static cameras   | 0.909 (ISSIA-CNR)      | Purpose-built for 8-16px balls              |
| **YOLO v11 + SAHI**     | General detection + tiling | 0.85-0.90 (panoramic)  | Generic but adaptable                       |
| **SoccerNet detection** | Broadcast footage          | 0.92+ (broadcast only) | Won't work on panoramic without fine-tuning |

**Hybrid tracking is mandatory (not optional):**
All three companies that do this at scale (Spiideo AutoFollow, Veo, Pixellot) use the same approach:

1. Track ball when detected with high confidence
2. Fall back to player cluster centroid when ball is lost
3. Apply heavy temporal smoothing to prevent jumps
4. Hold position during stoppages

We must implement the same hybrid approach from day one.

### 14.3 Portrait Conversion — Ready-Made vs Custom

| Option                                   | Cost/Match       | Quality               | Control                | Status                              |
| ---------------------------------------- | ---------------- | --------------------- | ---------------------- | ----------------------------------- |
| **Cloudinary `g_auto`**                  | ~$0.40/min video | Unknown (test needed) | Low — black box        | **Test first**                      |
| **OpusClip API**                         | Unknown          | Claims ball tracking  | Low — black box        | **Request API access**              |
| **FootAndBall + ByteTrack + FFmpeg**     | ~$0.50 (GPU)     | High (custom tuned)   | Full                   | Build if ready-made fails           |
| **YOLO v11 + SAHI + ByteTrack + FFmpeg** | ~$0.50 (GPU)     | Good                  | Full                   | Backup option                       |
| **Google AutoFlip**                      | N/A              | N/A                   | N/A                    | **DEPRECATED (dead since 2023)**    |
| **WSC Sports**                           | £50K-200K/yr     | Best                  | None — enterprise SaaS | Too expensive                       |
| **Generative AI (Luma, Runway)**         | N/A              | N/A                   | N/A                    | **Wrong tool** — fabricates content |

**Decision:**

1. **Week 1:** Test Cloudinary `g_auto` on 3-5 Spiideo recordings. If quality is acceptable, use it.
2. **Week 1:** Request OpusClip API access. If they have real ball tracking, evaluate.
3. **If both fail:** Build custom pipeline with FootAndBall + ByteTrack + FFmpeg.

**Do NOT use:** Google AutoFlip (deprecated 2023), generative AI models (they fabricate frames), or generic YOLO without tiling.

### 14.4 Video Captioning (Future)

| Option             | Cost/Match        | Best For                                      |
| ------------------ | ----------------- | --------------------------------------------- |
| **Gemini 3 Flash** | TBC (~$0.17 est.) | Bulk captioning, event descriptions           |
| **Twelve Labs**    | ~$3.00            | Semantic video search ("show me all corners") |

---

## 15. Risks and Mitigations

| Risk                                              | Impact                                                 | Likelihood  | Mitigation                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Ball detection AP too low on panoramic            | Portrait crop wanders aimlessly                        | Medium      | Hybrid tracking (ball + players). Test FootAndBall first. Accept that crop follows "action area" not "ball" most of the time.                  |
| Gemini 3 misses fast events (1 FPS sampling)      | Missing quick free kicks, deflections, rapid sequences | Medium      | Increase FPS for sports (2-5 FPS). Generous clip pre/post-roll (4s before, 10s after). Accept ~85% event recall as good enough for grassroots. |
| Gemini 3 timestamp drift on long videos           | Events mislocated by minutes                           | Medium-High | Chunk 90-min match into 6×15-min segments. Process each separately, merge events. Documented issue on Google forums.                           |
| 4K→720p transcode loses too much detail           | Gemini can't distinguish events                        | Low         | Test at 720p first. Fall back to default resolution (higher cost) if needed.                                                                   |
| Gemini 3 event detection accuracy insufficient    | <70% recall on grassroots footage                      | Medium      | Fall back to T-DEED (SoccerNet winner, proven CV model). More engineering but reliable.                                                        |
| Cloudinary g_auto doesn't follow ball             | Quality not acceptable for sports                      | Medium      | This is why we test it first on 3-5 recordings before committing. Have custom pipeline as fallback.                                            |
| Spiideo 4K files too large for Lambda (10GB /tmp) | Can't process in Lambda                                | Low         | Use EC2 for portrait conversion. Lambda only for final clip assembly (shorter clips).                                                          |
| GPU spot instance interruptions                   | Processing fails mid-job                               | Low         | Checkpoint progress. Use SQS with visibility timeout for retry. Spot interruption rate for g5 is ~5%.                                          |
| Gemini API rate limits at scale                   | Can't process 500 matches/week                         | Low         | Batch API has higher limits. Spread across 24 hours.                                                                                           |

---

_Phase 1 ships in 5 weeks. Week 1 validates both Gemini 3 Flash (event detection) and Cloudinary/OpusClip (portrait conversion) on real Spiideo recordings before committing to any approach. Spiideo 4K recordings get AI event tags + portrait conversion as a paid service. T-DEED (SoccerNet winner) is the fallback if Gemini doesn't perform. Brand overlays burned in from existing graphic packages. Partners download and post._
