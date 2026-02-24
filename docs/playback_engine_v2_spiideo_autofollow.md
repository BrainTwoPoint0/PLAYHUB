# PLAYBACK Engine v2 — Spiideo AutoFollow Pipeline

**Version:** 2.0 | **Date:** February 2026 | **Author:** Karim Fawaz, Founder & CEO
**Classification:** Internal / Engineering
**Supersedes:** v1.0 (generic panoramic pipeline)

---

## 1. Why This Version Exists

v1 assumed we'd build full CV from scratch on raw panoramic footage — player detection, ball tracking, multi-object tracking, the works. That's a 4-month, GPU-heavy build before anything ships.

The reality is simpler and faster:

**Spiideo AutoFollow already solves the hardest problem.** Their 3rd-gen AI model tracks gameplay, follows the ball, switches focus intelligently, and outputs a stabilized virtual camera view that stays on the action. It's essentially a broadcast-quality directed feed generated from their panoramic cameras.

**Spiideo AutoData is manual tagging, not AI.** It's humans marking events — expensive, slow, and why we're not using it.

**The gap is automated event detection + content generation.** Nobody is running an event classifier on AutoFollow output and auto-generating highlights for grassroots social media. That's the product.

```
What exists today:
[Spiideo Camera] → [AutoFollow AI] → [Tracked video on PLAYHUB] → Nothing happens

What we're building:
[Spiideo Camera] → [AutoFollow AI] → [PLAYHUB] → [PLAYBACK Engine] → [Events + Clips] → [Social / WhatsApp / Scouts]
                                                          │
                                              Replaces manual AutoData
                                              at zero marginal cost
```

---

## 2. Input Analysis: AutoFollow Output Characteristics

The AutoFollow feed is fundamentally different from raw panoramic footage. This changes every model decision:

| Property                 | Raw Panoramic                 | AutoFollow Output                                |
| ------------------------ | ----------------------------- | ------------------------------------------------ |
| **Field of view**        | Full pitch, 180°              | Zoomed to action area (~30-40% of pitch visible) |
| **Camera motion**        | Static                        | Virtual pan/zoom following play                  |
| **Player size**          | 15-50px tall (far side tiny)  | 80-200px tall (always reasonable size)           |
| **Ball visibility**      | Often < 10px, frequently lost | Usually visible, 15-30px                         |
| **Action framing**       | Action could be anywhere      | Action is centered by design                     |
| **Resolution**           | 4K spread across full pitch   | Effective ~1080p on area of interest             |
| **Broadcast similarity** | Low (wide static shot)        | High (looks like a single-camera broadcast)      |

**Key insight:** AutoFollow output is much closer to broadcast footage than to raw panoramic. This means:

- Academic models trained on broadcast soccer footage transfer better
- Player/ball detection is dramatically easier (larger objects, centered framing)
- The problem reduces from "find and track everything on the pitch" to "classify what's happening in the frame"
- We can use lighter models (no need for small-object specialists)

---

## 3. System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    PLAYBACK ENGINE v2                           │
│              (Spiideo AutoFollow Pipeline)                      │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    INGEST LAYER                           │  │
│  │                                                           │  │
│  │  [PLAYHUB webhook] ──► [Download AutoFollow MP4 from S3]  │  │
│  │                        [+ raw panoramic if available]      │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼──────────────────────────────┐  │
│  │                  EVENT DETECTION                           │  │
│  │                                                           │  │
│  │  [Frame Sampling] ──► [Scene Classifier] ──► [Event       │  │
│  │   2-4 fps            "what's happening?"     Manifest]    │  │
│  │                                                           │  │
│  │  Detects: goals, shots, saves, corners, cards,            │  │
│  │           free kicks, celebrations, kickoffs              │  │
│  │                                                           │  │
│  │  Outputs: {timestamp, event_type, confidence,             │  │
│  │            excitement_score, frame_thumbnail}              │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼──────────────────────────────┐  │
│  │                   CLIP ENGINE                              │  │
│  │                                                           │  │
│  │  [Event Manifest] ──► [FFmpeg clip extraction]            │  │
│  │                       [+ transitions]                     │  │
│  │                       [+ brand overlays]                  │  │
│  │                       [+ format conversion]               │  │
│  │                                                           │  │
│  │  Outputs:                                                 │  │
│  │    - Match highlight reel (60-90s, top events)            │  │
│  │    - Individual event clips (goal clip, save clip, etc.)  │  │
│  │    - Social-ready formats (9:16, 16:9, 1:1)              │  │
│  │    - Thumbnails (auto-selected key frames)                │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼──────────────────────────────┐  │
│  │                 DISTRIBUTION                               │  │
│  │                                                           │  │
│  │  [Clips] ──► [Social auto-publish]  Instagram / TikTok   │  │
│  │          ──► [PLAYHUB library]      OTT playback          │  │
│  │          ──► [WhatsApp]             Parent delivery (v2)  │  │
│  │          ──► [Partner dashboard]    Download / embed       │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 Service Stack

| Component              | Technology                                        | Why                                                  |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **API / Orchestrator** | Python 3.11 + FastAPI                             | Lightweight, async, perfect for ML serving           |
| **Event Detection**    | PyTorch (fine-tuned model)                        | Industry standard, matches WSC stack, huge ecosystem |
| **Video Processing**   | FFmpeg + MoviePy                                  | Battle-tested, handles all format conversions        |
| **Message Queue**      | Redis + BullMQ (or SQS)                           | Async job processing for match analysis              |
| **Storage**            | S3 / Cloudflare R2                                | Cheap, scalable, CDN-ready                           |
| **Database**           | Supabase (shared with PLAYHUB)                    | Already in use, no new infra                         |
| **Social Publishing**  | Instagram Graph API, TikTok API, YouTube Data API | Direct platform APIs                                 |
| **Deployment**         | AWS ECS (API) + single GPU instance (model)       | Minimal infra to start                               |

---

## 4. Event Detection Model — Technical Specification

### 4.1 Problem Definition

This is NOT a general object detection problem. It's a **temporal scene classification** problem:

Given a sequence of frames from an AutoFollow feed, classify whether a significant event is occurring and what type it is.

This is closer to action recognition than object detection. The AutoFollow camera has already "directed" the footage to point at the action. We just need to understand what we're looking at.

### 4.2 Model Architecture Options

| Approach                                | Model                                    | Pros                             | Cons                              | Recommendation                  |
| --------------------------------------- | ---------------------------------------- | -------------------------------- | --------------------------------- | ------------------------------- |
| **A: Frame-level classifier**           | ResNet50/EfficientNet + temporal pooling | Simple, fast, easy to train      | Misses temporal context           | Good for v0 prototype           |
| **B: Video clip classifier**            | SlowFast / TimeSformer / Video-MAE       | Understands motion, state-of-art | Heavier, needs more training data | Best for production             |
| **C: Two-stage (detect then classify)** | YOLO for objects + LSTM for events       | Interpretable, can track ball    | More complex pipeline             | Best long-term                  |
| **D: Fine-tuned foundation model**      | InternVideo2 / VideoLLaMA                | Zero/few-shot capable            | Slow inference, expensive         | Useful for bootstrapping labels |

**Recommended path:**

```
Week 1-2:  Approach D — Use a video LLM (GPT-4o / Claude vision) to
           bootstrap labels on 50-100 matches. Feed it 10-second clips
           and ask "what event is happening?" This creates your initial
           training dataset at near-zero annotation cost.

Week 3-4:  Approach A — Train a ResNet50 + temporal pooling classifier
           on the bootstrapped labels. Fast inference, runs on CPU even.
           Ship this as v0 to prove the pipeline works.

Week 5-8:  Approach B — Train SlowFast or TimeSformer on the growing
           dataset. Better accuracy, handles ambiguous events.
           This becomes the production model.

Month 3+:  Approach C — Add object-level detection (ball, players)
           for richer metadata. Enables player-level clips, tactical
           tags, and the "My Child" feature.
```

### 4.3 Event Categories

**Phase 1 (ship fast — these are detectable from AutoFollow with high confidence):**

| Event                   | Visual Signal in AutoFollow                                            | Difficulty                          |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| **Goal**                | Ball crosses line → celebration (players clustering, arms up, running) | Easy — celebration is unmistakable  |
| **Shot on target**      | Ball moving toward goal → keeper dive/reaction                         | Medium                              |
| **Save**                | Keeper dive + ball deflection                                          | Medium                              |
| **Corner kick**         | Ball placed in corner, players clustering in box                       | Easy — distinctive formation        |
| **Free kick**           | Player over ball, wall forming                                         | Easy — distinctive formation        |
| **Card (yellow/red)**   | Referee arm raised, players surrounding                                | Medium — need to detect ref gesture |
| **Penalty**             | Player at spot, keeper on line, distinctive camera framing             | Easy — very distinctive scene       |
| **Kickoff / Half-time** | Players at center, ball at center spot                                 | Easy — distinctive formation        |

**Phase 2 (after v1 is live):**

| Event             | Visual Signal                                                           |
| ----------------- | ----------------------------------------------------------------------- |
| **Near miss**     | Shot → ball goes wide/over → players react with disappointment          |
| **Counterattack** | Sudden transition from defense to attack, ball speed + direction change |
| **Tackle / Duel** | Two players contesting, one goes down                                   |
| **Substitution**  | Players at sideline exchanging                                          |

### 4.4 Excitement Scoring

Each detected event gets a score (0.0 - 5.0) based on:

```python
def compute_excitement(event, match_context):
    base_scores = {
        'goal': 5.0, 'penalty_goal': 5.0, 'penalty_miss': 4.5,
        'save': 3.5, 'shot_on_target': 3.0, 'red_card': 4.0,
        'yellow_card': 2.0, 'corner': 1.5, 'free_kick': 2.0,
        'near_miss': 3.5
    }
    score = base_scores.get(event.type, 1.0)

    # Context multipliers
    if match_context.minutes_remaining < 10:
        score *= 1.3  # Late game = more exciting
    if abs(match_context.score_diff) <= 1:
        score *= 1.2  # Close game = more exciting
    if event.type == 'goal' and match_context.is_equalizer:
        score *= 1.5  # Equalizer goal = peak excitement

    return min(score, 5.0)
```

### 4.5 Training Data Strategy

**The genius move:** Use a video LLM to bootstrap your training data.

```
Step 1: Take 100 Spiideo AutoFollow recordings from PLAYHUB
Step 2: Split each into 10-second clips at 1fps (just keyframes)
Step 3: Feed each clip to GPT-4o / Claude with the prompt:

        "You are watching a youth football match recorded from a
         single camera. What event is happening in this clip?
         Options: goal, shot_on_target, save, corner_kick,
         free_kick, yellow_card, red_card, penalty, kickoff,
         general_play, stoppage, nothing_significant.

         Also rate the excitement level 1-5.

         Respond in JSON: {event: str, confidence: float, excitement: int}"

Step 4: Filter for high-confidence labels (>0.8)
Step 5: Human QA on ~20% of labels (spot check)
Step 6: Train your lightweight model on this dataset
```

**Cost estimate for bootstrapping:**

- 100 matches × ~90 min × 6 clips/min = ~54,000 clips
- At ~$0.01/clip via GPT-4o mini with images = ~$540
- Compared to manual annotation: 100 matches × $50/match = $5,000+

**10x cheaper than Spiideo's AutoData, and you own the pipeline.**

### 4.6 Inference Pipeline

```python
# Production inference (runs per match, post-upload)

class EventDetector:
    def __init__(self, model_path: str):
        self.model = load_model(model_path)  # SlowFast or ResNet50
        self.fps = 2  # Sample 2 frames per second (sufficient for events)

    def analyze_match(self, video_path: str) -> EventManifest:
        frames = extract_frames(video_path, fps=self.fps)
        events = []

        # Sliding window: 5-second clips with 2.5s overlap
        window_size = self.fps * 5   # 10 frames
        stride = self.fps * 2.5      # 5 frames

        for i in range(0, len(frames) - window_size, int(stride)):
            clip = frames[i:i + window_size]
            prediction = self.model(clip)

            if prediction.confidence > 0.7 and prediction.event != 'general_play':
                events.append(Event(
                    timestamp=i / self.fps,
                    type=prediction.event,
                    confidence=prediction.confidence,
                    thumbnail=frames[i + window_size // 2]  # Middle frame
                ))

        # Deduplicate overlapping detections
        events = self.merge_nearby_events(events, min_gap_seconds=10)

        # Score excitement
        match_context = self.infer_match_context(events)
        for event in events:
            event.excitement = compute_excitement(event, match_context)

        return EventManifest(
            match_id=video_path,
            events=sorted(events, key=lambda e: e.timestamp),
            total_events=len(events),
            processing_time=time.time() - start
        )
```

### 4.7 Hardware & Performance

| Metric                              | ResNet50 (v0)              | SlowFast (v1)             |
| ----------------------------------- | -------------------------- | ------------------------- |
| **Inference time per match**        | ~3 min (CPU)               | ~8 min (GPU)              |
| **GPU required?**                   | No — runs on CPU           | Yes — A10G or T4          |
| **Model size**                      | ~100MB                     | ~400MB                    |
| **Monthly cost (500 matches/week)** | ~£0 (runs on existing ECS) | ~£400 (spot GPU instance) |
| **Expected accuracy**               | ~75% event detection       | ~88% event detection      |

---

## 5. Clip Generation Engine

### 5.1 Highlight Reel Generation

```python
class ClipEngine:
    def generate_highlight_reel(self, manifest: EventManifest,
                                 target_duration: int = 75) -> str:
        """
        Takes event manifest, produces a 60-90 second highlight reel.
        """
        # Sort by excitement, take top events that fit duration
        ranked = sorted(manifest.events, key=lambda e: e.excitement, reverse=True)

        selected = []
        total_duration = 0
        for event in ranked:
            clip_duration = self.get_clip_duration(event)  # 8-15s per event
            if total_duration + clip_duration <= target_duration:
                selected.append(event)
                total_duration += clip_duration

        # Re-sort chronologically for the reel
        selected.sort(key=lambda e: e.timestamp)

        # Build FFmpeg filter complex
        clips = []
        for event in selected:
            pre_roll = 4   # seconds before event
            post_roll = 6  # seconds after (catches celebration)

            if event.type == 'goal':
                post_roll = 10  # longer for goal celebrations

            clips.append({
                'start': max(0, event.timestamp - pre_roll),
                'end': event.timestamp + post_roll,
                'event_type': event.type
            })

        # FFmpeg: extract clips, add crossfade transitions, add overlay
        output_path = self.assemble_with_ffmpeg(
            source=manifest.source_video,
            clips=clips,
            overlay=self.build_overlay(manifest),  # Partner branding
            transition='crossfade',
            transition_duration=0.5
        )

        return output_path

    def assemble_with_ffmpeg(self, source, clips, overlay,
                              transition, transition_duration):
        """
        FFmpeg command to extract and concatenate clips with transitions.
        """
        # Step 1: Extract individual clips
        clip_files = []
        for i, clip in enumerate(clips):
            clip_path = f"/tmp/clip_{i}.mp4"
            subprocess.run([
                'ffmpeg', '-y',
                '-ss', str(clip['start']),
                '-i', source,
                '-t', str(clip['end'] - clip['start']),
                '-c:v', 'libx264', '-preset', 'fast',
                '-c:a', 'aac',
                clip_path
            ])
            clip_files.append(clip_path)

        # Step 2: Concatenate with crossfade transitions
        # (using ffmpeg xfade filter for smooth transitions)
        output = f"/tmp/highlight_{uuid4()}.mp4"
        # ... ffmpeg filter_complex for xfade between clips

        # Step 3: Apply brand overlay (partner logo, match info)
        if overlay:
            self.apply_overlay(output, overlay)

        return output
```

### 5.2 Output Formats

| Format              | Specs                        | Use Case                           | FFmpeg flags                            |
| ------------------- | ---------------------------- | ---------------------------------- | --------------------------------------- |
| **Social Vertical** | 1080x1920, 9:16, H.264, <60s | Instagram Reels, TikTok, YT Shorts | `-vf "crop=ih*9/16:ih,scale=1080:1920"` |
| **Social Square**   | 1080x1080, 1:1, H.264        | Instagram Feed, X/Twitter          | `-vf "crop=ih:ih,scale=1080:1080"`      |
| **Full Horizontal** | 1920x1080, 16:9, H.264       | YouTube, PLAYHUB, website embed    | Direct copy (native format)             |
| **WhatsApp**        | 480x854, 9:16, H.264, <16MB  | Parent delivery                    | `-vf "scale=480:854" -b:v 1M`           |
| **Thumbnail**       | 1280x720, JPEG, 85% quality  | Social preview, PLAYHUB listing    | Single frame extraction                 |

### 5.3 Brand Overlay System

```python
class BrandOverlay:
    """
    Each partner org has a brand config stored in Supabase.
    Applied to every generated clip automatically.
    """
    def build_overlay(self, manifest):
        org = get_org_config(manifest.organization_id)

        return {
            'logo': org.logo_url,           # Top-left corner
            'logo_position': 'top-left',
            'logo_size': '10%',             # 10% of frame width

            'match_info': {                  # Bottom bar
                'home_team': manifest.home_team,
                'away_team': manifest.away_team,
                'score': manifest.final_score,  # If available
                'date': manifest.date,
                'competition': manifest.competition_name
            },

            'sponsor_logo': org.sponsor_logo_url,  # Top-right (monetizable)
            'watermark': 'PLAYBACK',                # Subtle bottom-right

            'intro_card': {                  # 2-second intro slide
                'title': f"{manifest.home_team} vs {manifest.away_team}",
                'subtitle': f"Highlights | {manifest.date}",
                'background': org.brand_color
            }
        }
```

---

## 6. Distribution Engine

### 6.1 Social Auto-Publishing (Phase 1 Priority)

```python
class SocialPublisher:
    """
    Auto-publish highlights to partner social accounts.
    """

    async def publish_match_highlights(self, match_id: str, clips: dict):
        org = await get_org(match_id)

        for platform in org.connected_platforms:
            clip = clips[platform.preferred_format]  # 9:16 for IG/TT, 16:9 for YT

            caption = self.generate_caption(
                match=match,
                platform=platform.name,
                tone=org.caption_tone  # 'hype', 'professional', 'casual'
            )

            if platform.name == 'instagram':
                await self.publish_instagram_reel(
                    video_path=clip,
                    caption=caption,
                    account=platform.credentials
                )
            elif platform.name == 'tiktok':
                await self.publish_tiktok(
                    video_path=clip,
                    caption=caption,
                    account=platform.credentials
                )
            elif platform.name == 'youtube':
                await self.publish_youtube_short(
                    video_path=clip,
                    title=f"{match.home} vs {match.away} | Highlights",
                    description=caption,
                    account=platform.credentials
                )

            # Track distribution
            await supabase.from_('clip_distributions').insert({
                'clip_id': clip.id,
                'channel': platform.name,
                'status': 'sent',
                'sent_at': datetime.utcnow()
            })

    def generate_caption(self, match, platform, tone):
        """Generate platform-appropriate caption."""
        if tone == 'hype':
            return (
                f"🔥 HIGHLIGHTS | {match.home} vs {match.away}\n"
                f"⚽ {match.total_goals} goals in this one!\n"
                f"\n"
                f"#grassrootsfootball #{match.home_hashtag} "
                f"#{match.away_hashtag} #PLAYBACK"
            )
        # ... other tones
```

### 6.2 Partner Dashboard Integration

Each partner org gets a simple view in PLAYHUB:

```
Partner Dashboard (PLAYHUB):

┌─────────────────────────────────────────────────────┐
│  Recent Matches                                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ [thumb]  │  │ [thumb]  │  │ [thumb]  │          │
│  │ U14 vs   │  │ U16 vs   │  │ U12 vs   │          │
│  │ City FC  │  │ Rangers  │  │ United   │          │
│  │ 3 events │  │ 7 events │  │ 2 events │          │
│  │ ✅ Clips │  │ ✅ Clips │  │ ⏳ Proc  │          │
│  │  ready   │  │  ready   │  │  essing  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  [Download All]  [Publish to Social]  [View Clips]  │
└─────────────────────────────────────────────────────┘
```

---

## 7. Data Architecture

### 7.1 Supabase Schema (Minimal — extends existing PLAYHUB tables)

```sql
-- Event detection results (one per analyzed match)
CREATE TABLE match_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_recording_id UUID REFERENCES match_recordings(id),
    status TEXT CHECK (status IN ('queued','processing','completed','failed')),
    event_manifest JSONB,
    model_version TEXT,
    processing_time_seconds FLOAT,
    total_events_detected INTEGER,
    avg_confidence FLOAT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Generated clips (multiple per match)
CREATE TABLE generated_clips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_analysis_id UUID REFERENCES match_analysis(id),
    clip_type TEXT CHECK (clip_type IN (
        'highlight_reel','goal_clip','save_clip',
        'event_clip','social_vertical','social_square'
    )),
    event_type TEXT,               -- 'goal', 'save', etc. (NULL for reel)
    event_timestamp FLOAT,         -- seconds into match
    excitement_score FLOAT,
    duration_seconds FLOAT,
    formats JSONB,                 -- {"vertical": "s3://...", "horizontal": "s3://..."}
    thumbnail_url TEXT,
    overlay_config JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Distribution tracking
CREATE TABLE clip_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_id UUID REFERENCES generated_clips(id),
    channel TEXT CHECK (channel IN (
        'instagram','tiktok','youtube','playhub','download'
    )),
    status TEXT CHECK (status IN ('pending','sent','published','failed')),
    platform_post_id TEXT,         -- ID from the platform (for tracking)
    published_at TIMESTAMPTZ,
    engagement JSONB               -- {views: N, likes: N, shares: N}
);

-- Indexes
CREATE INDEX idx_analysis_status ON match_analysis(status);
CREATE INDEX idx_analysis_recording ON match_analysis(match_recording_id);
CREATE INDEX idx_clips_analysis ON generated_clips(match_analysis_id);
CREATE INDEX idx_distributions_clip ON clip_distributions(clip_id);
```

### 7.2 S3/R2 Storage

```
playback-engine/
├── clips/{match_id}/
│   ├── highlight_reel_16x9.mp4
│   ├── highlight_reel_9x16.mp4
│   ├── highlight_reel_1x1.mp4
│   ├── events/
│   │   ├── goal_1_16x9.mp4
│   │   ├── goal_1_9x16.mp4
│   │   ├── save_1_16x9.mp4
│   │   └── ...
│   └── thumbnails/
│       ├── highlight_thumb.jpg
│       ├── goal_1_thumb.jpg
│       └── ...
└── models/
    ├── event_detector_v0.pt      # ResNet50 prototype
    ├── event_detector_v1.pt      # SlowFast production
    └── training_data/
        └── labels/               # Bootstrapped + QA'd labels
```

---

## 8. API Design

```
PLAYBACK Engine API (FastAPI):

# Trigger analysis (called by PLAYHUB when match upload completes)
POST /api/v1/matches/{match_id}/analyze
  Body: { "source_url": "s3://...", "organization_id": "uuid" }
  Response: { "analysis_id": "uuid", "status": "queued" }

# Check status
GET /api/v1/matches/{match_id}/status
  Response: { "status": "completed", "events_detected": 7, "clips_ready": true }

# Get event manifest
GET /api/v1/matches/{match_id}/events
  Response: { "events": [{ "type": "goal", "timestamp": 1234.5, ... }] }

# Get generated clips
GET /api/v1/matches/{match_id}/clips
  Response: { "clips": [{ "type": "highlight_reel", "formats": {...}, ... }] }

# Trigger social publish
POST /api/v1/matches/{match_id}/publish
  Body: { "platforms": ["instagram", "tiktok"], "clip_type": "highlight_reel" }
  Response: { "distributions": [{ "platform": "instagram", "status": "pending" }] }

# Webhook from PLAYHUB (new recording ready)
POST /api/v1/webhooks/playhub
  Body: { "event": "recording_complete", "match_id": "uuid", "source_url": "..." }

# Health
GET /api/v1/health
```

### 8.1 PLAYHUB Integration Flow

```
Recording completes on Spiideo
        │
        ▼
PLAYHUB receives AutoFollow MP4
(already happens today)
        │
        ▼
PLAYHUB fires webhook to Engine
POST /api/v1/webhooks/playhub
        │
        ▼
Engine queues analysis job (Redis)
        │
        ▼
Worker downloads video, runs event detection
(~3-8 min depending on model)
        │
        ▼
Worker generates clips (FFmpeg)
(~2-3 min for all formats)
        │
        ▼
Worker uploads clips to S3/R2
        │
        ▼
Worker updates Supabase (match_analysis + generated_clips)
        │
        ▼
Engine fires webhook back to PLAYHUB
"clips_ready" event
        │
        ▼
PLAYHUB displays clips in partner dashboard
+ triggers auto-publish if configured
        │
        ▼
Partner's social accounts get highlights automatically
(15-30 min after match ends)
```

---

## 9. Deployment

```
Phase 1 Deployment (Minimal):

┌──────────────────────────────────────────┐
│              AWS (eu-west-2)             │
│                                          │
│  ┌────────────────┐  ┌───────────────┐  │
│  │ ECS Fargate     │  │ EC2 Spot      │  │
│  │                 │  │ (g5.xlarge)   │  │
│  │ Engine API      │  │               │  │
│  │ (FastAPI)       │  │ CV Worker     │  │
│  │                 │  │ (PyTorch)     │  │
│  │ Clip Generator  │  │               │  │
│  │ (FFmpeg)        │  │ Only runs     │  │
│  │                 │  │ during batch  │  │
│  │ Social Publisher│  │ processing    │  │
│  └───────┬────────┘  └──────┬────────┘  │
│          │                   │           │
│  ┌───────▼───────────────────▼────────┐  │
│  │         Redis (ElastiCache)         │  │
│  │         Job queue                   │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │ S3 / R2       │  │ Supabase        │  │
│  │ (clips)       │  │ (DB - existing) │  │
│  └──────────────┘  └─────────────────┘  │
└──────────────────────────────────────────┘

External:
├── Netlify → PLAYHUB (playhub.playbacksports.ai)
├── Instagram Graph API
├── TikTok Content Posting API
└── YouTube Data API v3

Monthly Cost Estimate (Phase 1):
├── ECS Fargate (API + FFmpeg): ~£150/mo
├── EC2 Spot g5.xlarge (GPU, ~20hrs/week): ~£200/mo
├── Redis (ElastiCache t3.micro): ~£15/mo
├── S3 storage (~500GB clips/month): ~£12/mo
├── S3 egress + CDN: ~£30/mo
└── TOTAL: ~£400-500/mo
```

**That's less than one month of manual AutoData costs.**

---

## 10. Build Plan — 6 Weeks to First Highlights

### Week 1: Foundation

- [ ] FastAPI service scaffold with health endpoint
- [ ] S3 bucket setup (playback-engine/)
- [ ] Redis queue setup
- [ ] Supabase schema migration (match_analysis, generated_clips, clip_distributions)
- [ ] PLAYHUB webhook endpoint (receive recording_complete events)

### Week 2: Training Data Bootstrap

- [ ] Script to download AutoFollow recordings from PLAYHUB/Spiideo
- [ ] Script to split recordings into 10-second clips at 2fps
- [ ] GPT-4o / Claude vision labeling pipeline (batch API)
- [ ] Label QA interface (simple web page to verify/correct labels)
- [ ] Target: 50 matches labeled by end of week

### Week 3: Event Detection Model v0

- [ ] Train ResNet50 + temporal pooling on bootstrapped labels
- [ ] Evaluation on held-out test set (target: >70% accuracy on goals/corners)
- [ ] Inference pipeline: video in → event manifest out
- [ ] Integration with job queue (worker picks up analysis jobs)

### Week 4: Clip Engine

- [ ] FFmpeg clip extraction from timestamps
- [ ] Highlight reel assembly (top N events by excitement, crossfade transitions)
- [ ] Format conversion (16:9, 9:16, 1:1)
- [ ] Brand overlay rendering (partner logo, match info bar)
- [ ] Thumbnail generation (key frame extraction)
- [ ] Upload to S3, update Supabase

### Week 5: Distribution + PLAYHUB Integration

- [ ] Instagram Reels auto-publish (Graph API)
- [ ] TikTok auto-publish (Content Posting API)
- [ ] YouTube Shorts auto-publish (Data API v3)
- [ ] Caption generation (template-based, per platform)
- [ ] PLAYHUB dashboard: show generated clips per match
- [ ] PLAYHUB: download clips, trigger manual publish

### Week 6: Testing + First Partner Pilot

- [ ] End-to-end test: Spiideo recording → PLAYHUB → Engine → clips → social
- [ ] Run on 20 real matches from one partner
- [ ] Measure: detection accuracy, clip quality, publish success rate
- [ ] Partner feedback session
- [ ] Fix critical issues
- [ ] **Ship to first partner org** 🚀

### Post-Launch (Weeks 7-12):

- [ ] Train SlowFast model on growing dataset (accuracy → 88%+)
- [ ] Add more event types (tackles, near misses, counterattacks)
- [ ] Engagement tracking (views, likes, shares per clip)
- [ ] A/B test thumbnail styles
- [ ] WhatsApp parent delivery (Phase 2 feature)
- [ ] Player-level clips using panoramic footage + tracking (Phase 2)

---

## 11. Success Metrics

| Metric                                    | Week 6 (Launch)      | Month 3         | Month 6         |
| ----------------------------------------- | -------------------- | --------------- | --------------- |
| Matches auto-analyzed                     | 20/week              | 200/week        | 500/week        |
| Clips auto-generated                      | 100/week             | 1,000/week      | 5,000/week      |
| Social posts published                    | 40/week              | 400/week        | 1,000/week      |
| Event detection accuracy                  | >70% goals           | >85% all events | >90% all events |
| Time: match end → clips ready             | <30 min              | <20 min         | <15 min         |
| Partner orgs using                        | 1                    | 5               | 15+             |
| Manual AutoData cost replaced             | £0 (wasn't using it) | £0              | £0              |
| Social engagement lift (partner accounts) | Baseline             | +50%            | +100%           |

---

## 12. Cost Comparison

| Approach                      | Monthly Cost  | Clips/Month | Cost/Clip  |
| ----------------------------- | ------------- | ----------- | ---------- |
| **Spiideo AutoData (manual)** | ~£2,000-5,000 | ~200        | £10-25     |
| **Hire a video editor**       | ~£3,000+      | ~100-200    | £15-30     |
| **PLAYBACK Engine**           | ~£400-500     | 4,000+      | £0.10-0.12 |

**100x cheaper per clip. Fully automated. Scales linearly.**

---

## 13. Future: From AutoFollow Events to Full Platform

This Phase 1 pipeline (AutoFollow → events → clips → social) is the wedge. Once it's live and generating content, the path to the full PLAYBACK Engine (v1 spec) becomes:

```
Phase 1 (THIS DOC):
AutoFollow footage → Event detection → Highlights → Social publishing
Timeline: 6 weeks | Cost: ~£500/mo

Phase 2 (Month 3-6):
+ Raw panoramic footage → Player tracking → "My Child" clips → WhatsApp
+ Player profiles + auto-showreels
+ Scout portal
Timeline: 3-4 months | Cost: ~£2,000/mo

Phase 3 (Month 6-12):
+ Tactical analysis (formations, press, transitions)
+ AI commentary / captions (multilingual)
+ Development tracking (player progression over time)
+ Multi-sport models (padel, cricket)
Timeline: 6 months | Cost: ~£5,000/mo

Phase 4 (Year 2):
+ Full WSC-equivalent platform
+ PLAYBACK Network (content syndication)
+ Predictive development insights
+ Revenue: £500K-2M ARR
```

The key insight: **Phase 1 generates immediate value (social content for partners) with minimal investment, proving the pipeline works before committing to the full CV stack.**

---

## 14. What We DON'T Build in Phase 1

Explicitly out of scope to keep the 6-week timeline:

| Feature                          | Why Not Yet                                     | When               |
| -------------------------------- | ----------------------------------------------- | ------------------ |
| Player identification / tracking | Needs panoramic footage + annotation investment | Phase 2            |
| "My Child" player-level clips    | Needs player tracking first                     | Phase 2            |
| WhatsApp parent delivery         | Needs player-level clips + parent onboarding    | Phase 2            |
| Tactical analysis                | Needs full-pitch view + formation detection     | Phase 3            |
| Scout portal                     | Needs player profiles + showreels               | Phase 2            |
| AI commentary / voiceover        | Nice-to-have, not core                          | Phase 3            |
| Multi-sport models               | Football first, expand after                    | Phase 3            |
| Real-time (live) processing      | Post-match processing is fine for grassroots    | Never (or Phase 4) |

---

_Phase 1 ships in 6 weeks. Replaces manual tagging at 100x lower cost. Every match auto-generates branded highlights for social. The data flywheel starts spinning from day one._
