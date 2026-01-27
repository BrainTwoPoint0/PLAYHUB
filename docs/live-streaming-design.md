# PLAYHUB Live Streaming Infrastructure Design

## Overview

This document outlines the architecture for implementing RTMP-based live streaming on PLAYHUB, replacing the current YouTube relay approach for Spiideo Play streams. The solution enables flexible access control models, monetization, and **raw file retention for future AI processing**.

## Use Case Parameters

| Parameter              | Value                                        |
| ---------------------- | -------------------------------------------- |
| **Stream Duration**    | 60-70 minutes typical                        |
| **Concurrent Viewers** | Up to 10 per stream                          |
| **Audience**           | Grassroots players, recreational             |
| **DVR Required**       | Yes (rewind during live)                     |
| **Recording Required** | Yes (for retrospective purchase + future AI) |
| **Access Models**      | Free, private, pay-per-view, group unlock    |
| **Raw File Retention** | Yes (for AI highlight extraction later)      |

## Current State

### What We Have

- **PLAYBACK AWS Account (eu-west-2)**: Lambda function for PLAYScanner data collection
- **PLAYHUB**: Next.js 14 app with Supabase backend, Stripe integration, basic purchase flow
- **Spiideo Play**: Currently broadcasts via YouTube RTMP (we provide YouTube's RTMP key)
- **Shared Auth**: Supabase authentication across PLAYBACK and PLAYHUB

### The Problem

- Relying on YouTube for streaming means no control over access
- Cannot implement pay-per-view or gated content
- No analytics or user tracking on stream viewership
- YouTube's terms may conflict with commercial redistribution
- No raw files retained for future AI processing

---

## Spiideo Play Technical Requirements

Based on [Spiideo's documentation](https://support.spiideo.com/en/articles/5204129-stream-via-rtmp-srt-to-your-platform):

### RTMP/SRT Streaming from Spiideo

| Requirement             | Specification                                 |
| ----------------------- | --------------------------------------------- |
| **Upload Speed**        | 15 Mbps per camera minimum                    |
| **Protocols Supported** | RTMP and SRT                                  |
| **RTMP Format**         | URL + Stream Key (separate fields)            |
| **SRT Format**          | `srt://<ip>:<port>?<parameters>`              |
| **Stream Key**          | Must be unique per broadcast (no overlapping) |

### Key Constraints

- Each game requires its own unique stream key
- Overlapping broadcasts with same key will fail
- Spiideo handles encoding/compression before sending to our endpoint
- **No metadata transmitted** - only raw video stream (title, teams etc. must be entered in PLAYHUB separately)

---

## Why AWS MediaLive (Not Cloudflare/IVS)

| Factor                   | Cloudflare Stream  | AWS IVS            | AWS MediaLive + S3   |
| ------------------------ | ------------------ | ------------------ | -------------------- |
| **Raw file access**      | ❌ Transcoded only | ❌ Transcoded only | ✅ **Raw HLS in S3** |
| **Future AI processing** | ❌ Hard            | ❌ Hard            | ✅ **Full control**  |
| **SRT support**          | ❌ No              | ❌ No              | ✅ **Yes**           |
| **Cost per stream**      | ~$1.00             | ~$0.82             | ~$0.90               |
| **Existing AWS account** | ❌ New vendor      | ✅ Same            | ✅ **Same**          |
| **Custom workflows**     | ❌ Limited         | ❌ Limited         | ✅ **Full control**  |
| **Setup complexity**     | Simple             | Medium             | Complex              |

**Decision: AWS MediaLive + S3 + CloudFront**

This gives us:

1. **Paywall now** via CloudFront signed URLs
2. **Raw recordings in S3** for future AI highlight extraction
3. **Full control** over storage, retention, and processing
4. **One vendor** (AWS) for all infrastructure

---

## Recommended Architecture

### High-Level Flow

```
┌─────────────────┐      RTMP       ┌──────────────────────────────────────────────────┐
│  Spiideo Play   │────────────────▶│              AWS Infrastructure                  │
│  (Broadcaster)  │                 │                                                  │
└─────────────────┘                 │  ┌────────────────────────────────────────────┐  │
                                    │  │         MediaLive (Ingest + Encode)        │  │
                                    │  │  - RTMP input endpoint                     │  │
                                    │  │  - Transcodes to multiple bitrates         │  │
                                    │  │  - Outputs HLS to MediaPackage + S3        │  │
                                    │  └──────────────┬─────────────┬───────────────┘  │
                                    │                 │             │                  │
                                    │       ┌────────▼────────┐    │                  │
                                    │       │  MediaPackage   │    │                  │
                                    │       │  - HLS packaging │    │                  │
                                    │       │  - DVR (rewind)  │    │                  │
                                    │       └────────┬────────┘    │                  │
                                    │                │             │                  │
                                    │       ┌────────▼────────┐   ┌▼─────────────────┐│
                                    │       │   CloudFront    │   │   S3 Bucket      ││
                                    │       │  - CDN delivery │   │  - Raw HLS files ││
                                    │       │  - Signed URLs  │   │  - Future AI     ││
                                    │       │  - Paywall      │   │  - Long-term     ││
                                    │       └────────┬────────┘   └──────────────────┘│
                                    └────────────────┼────────────────────────────────┘
                                                     │
                                                     │ HLS (Signed URL)
                                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              PLAYHUB Application                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────────────────────┐    │
│  │   Next.js API   │  │   Supabase DB   │  │      HLS.js Video Player          │    │
│  │ - Access check  │  │ - Stream config │  │  - Plays signed HLS URL           │    │
│  │ - URL signing   │  │ - User access   │  │  - DVR controls                   │    │
│  │ - Stripe hooks  │  │ - Payments      │  │  - Quality selection              │    │
│  └─────────────────┘  └─────────────────┘  └───────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Summary

```
Spiideo → RTMP → MediaLive → MediaPackage → CloudFront → Viewer
                     ↓
                    S3 (raw HLS segments for future AI)
```

---

## Access Control Models

### 1. Free & Public

- No authentication required
- CloudFront serves directly without signed URLs
- Use case: Promotional streams, community events

### 2. Private (Link-Only)

- Requires valid stream link (UUID-based)
- No payment required, but link must be shared explicitly
- Use case: Team-only streams, private events

### 3. Pay-Per-View (Individual)

- User must purchase access before watching
- Signed URL generated per-user with expiry
- Use case: Premium matches, tournaments

### 4. Pay-Once-Unlock-All (Group Unlock)

- First purchase unlocks stream for everyone with the link
- "Someone paid" flag in database
- Use case: Team fundraisers, community sponsorship model

### 5. Subscription-Based (Future)

- Season pass or organization subscription
- Access to all streams from an organization
- Use case: Club memberships

---

## Database Schema

### New Tables for Live Streaming

```sql
-- Live stream configuration
CREATE TABLE playhub_live_streams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Organization/owner
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id),

  -- Stream metadata
  title TEXT NOT NULL,
  description TEXT,
  sport_id UUID REFERENCES sports(id),
  scheduled_start TIMESTAMP WITH TIME ZONE NOT NULL,
  scheduled_end TIMESTAMP WITH TIME ZONE,

  -- Match metadata (optional)
  home_team TEXT,
  away_team TEXT,
  venue TEXT,
  competition TEXT,

  -- Access control
  access_type TEXT NOT NULL DEFAULT 'private',
  -- 'public', 'private_link', 'pay_per_view', 'group_unlock', 'subscription'

  -- Pricing (for paid access types)
  price_amount DECIMAL(10,2),
  currency TEXT DEFAULT 'GBP',
  stripe_product_id TEXT,
  stripe_price_id TEXT,

  -- Group unlock tracking
  is_unlocked BOOLEAN DEFAULT false,
  unlocked_by UUID REFERENCES auth.users(id),
  unlocked_at TIMESTAMP WITH TIME ZONE,

  -- AWS Infrastructure IDs
  medialive_channel_id TEXT,          -- MediaLive channel ARN
  medialive_input_id TEXT,            -- MediaLive input ARN
  mediapackage_channel_id TEXT,       -- MediaPackage channel ID
  mediapackage_endpoint_id TEXT,      -- MediaPackage endpoint ID

  -- RTMP credentials (for broadcaster)
  rtmp_url TEXT,                      -- rtmp://<medialive-input-endpoint>/live
  rtmp_stream_key TEXT,               -- Unique stream key

  -- Playback URLs
  playback_url TEXT,                  -- CloudFront HLS URL
  cloudfront_distribution_id TEXT,    -- CloudFront distribution ID

  -- S3 Recording
  recording_s3_bucket TEXT,           -- S3 bucket name
  recording_s3_prefix TEXT,           -- S3 path prefix for this stream

  -- Stream status
  status TEXT DEFAULT 'scheduled',
  -- 'scheduled', 'live', 'ended', 'cancelled'

  -- Recording settings
  enable_recording BOOLEAN DEFAULT true,

  -- Thumbnails
  thumbnail_url TEXT,

  -- Timestamps
  actual_start TIMESTAMP WITH TIME ZONE,
  actual_end TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_access_type CHECK (
    access_type IN ('public', 'private_link', 'pay_per_view', 'group_unlock', 'subscription')
  ),
  CONSTRAINT valid_stream_status CHECK (
    status IN ('scheduled', 'live', 'ended', 'cancelled')
  )
);

-- Stream access rights
CREATE TABLE playhub_stream_access (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  stream_id UUID REFERENCES playhub_live_streams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- How access was granted
  access_source TEXT NOT NULL,
  -- 'purchase', 'group_unlock', 'manual_grant', 'subscription'

  -- Payment reference
  purchase_id UUID REFERENCES playhub_purchases(id),

  -- Access validity
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE, -- NULL = no expiry
  is_active BOOLEAN DEFAULT true,

  -- Unique: one access record per user per stream
  UNIQUE(stream_id, user_id)
);

-- Stream view sessions (analytics)
CREATE TABLE playhub_stream_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  stream_id UUID REFERENCES playhub_live_streams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),

  -- Session tracking
  session_token TEXT UNIQUE,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE,

  -- Viewing stats
  total_watch_seconds INTEGER DEFAULT 0,
  peak_quality TEXT, -- '1080p', '720p', '480p', '360p'

  -- Device info
  device_type TEXT,
  browser TEXT,
  ip_country TEXT,

  -- Engagement
  chat_messages_sent INTEGER DEFAULT 0,
  reactions_sent INTEGER DEFAULT 0
);

-- Indexes
CREATE INDEX idx_live_streams_org ON playhub_live_streams(organization_id);
CREATE INDEX idx_live_streams_status ON playhub_live_streams(status);
CREATE INDEX idx_live_streams_scheduled ON playhub_live_streams(scheduled_start);
CREATE INDEX idx_stream_access_user ON playhub_stream_access(user_id);
CREATE INDEX idx_stream_access_stream ON playhub_stream_access(stream_id);
CREATE INDEX idx_stream_sessions_stream ON playhub_stream_sessions(stream_id);
```

### RLS Policies

```sql
-- Enable RLS
ALTER TABLE playhub_live_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE playhub_stream_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE playhub_stream_sessions ENABLE ROW LEVEL SECURITY;

-- Streams: Public can view public streams
CREATE POLICY "Public can view scheduled/live public streams"
  ON playhub_live_streams FOR SELECT
  USING (
    access_type = 'public'
    AND status IN ('scheduled', 'live')
  );

-- Streams: Authenticated users can view streams they have access to
CREATE POLICY "Users can view streams they have access to"
  ON playhub_live_streams FOR SELECT
  USING (
    id IN (
      SELECT stream_id FROM playhub_stream_access
      WHERE user_id = auth.uid() AND is_active = true
    )
    OR access_type = 'public'
    OR (access_type = 'group_unlock' AND is_unlocked = true)
  );

-- Organization members can manage their streams
CREATE POLICY "Organization members can manage streams"
  ON playhub_live_streams FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid() AND role IN ('admin', 'manager')
    )
  );

-- Access: Users can view their own access
CREATE POLICY "Users can view own stream access"
  ON playhub_stream_access FOR SELECT
  USING (user_id = auth.uid());

-- Sessions: Users can manage their own sessions
CREATE POLICY "Users can manage own sessions"
  ON playhub_stream_sessions FOR ALL
  USING (user_id = auth.uid());
```

---

## AWS Cost Estimates

### Per-Stream Cost (65 min, 10 viewers)

| Component                        | Calculation         | Cost       |
| -------------------------------- | ------------------- | ---------- |
| **MediaLive** (Standard channel) | 1.1 hr × $0.354/hr  | $0.39      |
| **MediaPackage** (Packaging)     | 1 GB × $0.05/GB     | $0.05      |
| **CloudFront** (Delivery)        | 2 GB × $0.085/GB    | $0.17      |
| **S3 Storage** (Recording)       | 2 GB × $0.023/GB/mo | $0.05      |
| **S3 Requests**                  | ~1000 requests      | $0.01      |
| **Total per stream**             |                     | **~$0.67** |

### Monthly Estimates

| Streams/Month | MediaLive | MediaPackage | CloudFront | S3    | Total    |
| ------------- | --------- | ------------ | ---------- | ----- | -------- |
| 10 streams    | $3.90     | $0.50        | $1.70      | $0.50 | **~$7**  |
| 20 streams    | $7.80     | $1.00        | $3.40      | $1.00 | **~$13** |
| 40 streams    | $15.60    | $2.00        | $6.80      | $2.00 | **~$26** |

_Note: S3 storage accumulates over time if recordings are kept_

### Cost Comparison

| Platform          | Per Stream | Monthly (20 streams) | Raw Files | AI-Ready |
| ----------------- | ---------- | -------------------- | --------- | -------- |
| **AWS MediaLive** | ~$0.67     | ~$13                 | ✅ Yes    | ✅ Yes   |
| Cloudflare Stream | ~$1.00     | ~$20                 | ❌ No     | ❌ No    |
| AWS IVS           | ~$0.82     | ~$16                 | ❌ No     | ❌ No    |

---

## Implementation Phases

### Phase 1: AWS Infrastructure Setup

- [ ] Create S3 bucket for recordings (`playhub-recordings-eu-west-2`)
- [ ] Create IAM roles for MediaLive, MediaPackage
- [ ] Create MediaPackage channel (reusable for all streams)
- [ ] Create CloudFront distribution with signed URL support
- [ ] Generate CloudFront key pair for signing
- [ ] Set up environment variables in PLAYHUB

### Phase 2: Stream Lifecycle Lambda

- [ ] Lambda: Create MediaLive channel + input on demand
- [ ] Lambda: Start/stop MediaLive channel
- [ ] Lambda: Clean up resources after stream ends
- [ ] EventBridge: Detect stream start/end events
- [ ] Update stream status in Supabase

### Phase 3: Stream Management API

- [ ] `/api/streams` - CRUD for stream configuration
- [ ] `/api/streams/[id]/provision` - Create AWS resources, get RTMP credentials
- [ ] `/api/streams/[id]/start` - Start MediaLive channel
- [ ] `/api/streams/[id]/stop` - Stop channel, finalize recording
- [ ] `/api/streams/[id]/access` - Check/grant access
- [ ] `/api/streams/[id]/playback-url` - Generate signed CloudFront URL
- [ ] Update Stripe webhooks for stream purchases

### Phase 4: Broadcaster Experience

- [ ] Stream creation form (schedule, access type, pricing)
- [ ] RTMP credentials display page (URL + Stream Key for Spiideo)
- [ ] Stream status dashboard (live/offline indicator)
- [ ] Test stream functionality

### Phase 5: Viewer Experience

- [ ] Stream listing page (upcoming, live now)
- [ ] Stream detail page with access gate
- [ ] HLS.js video player with signed URL
- [ ] Purchase flow for paid streams
- [ ] "Watch" button with access verification
- [ ] DVR controls (rewind during live)

### Phase 6: Group Unlock Model

- [ ] "Sponsor this stream" payment flow
- [ ] Real-time unlock notification (Supabase realtime)
- [ ] Unlocked stream indicator
- [ ] Thank-you attribution for sponsor

### Phase 7: Recording & VOD Integration

- [ ] Link S3 recordings to `playhub_match_recordings` after stream ends
- [ ] Recording access control (same access as live, or separate purchase)
- [ ] Recording purchase flow for retrospective buyers
- [ ] Recording listing in user library

### Phase 8: Analytics & Monitoring

- [ ] CloudWatch dashboard for stream health
- [ ] Viewer count tracking
- [ ] Watch time analytics
- [ ] Revenue reporting per stream
- [ ] Cost monitoring alerts

---

## Technical Implementation Details

### Environment Variables

```bash
# .env.local

# AWS Credentials (or use IAM role)
AWS_REGION=eu-west-2
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# MediaLive
MEDIALIVE_ROLE_ARN=arn:aws:iam::xxx:role/MediaLiveAccessRole

# MediaPackage
MEDIAPACKAGE_CHANNEL_ID=playhub-live-channel

# CloudFront
CLOUDFRONT_DISTRIBUTION_ID=E1234567890
CLOUDFRONT_DOMAIN=d1234567890.cloudfront.net
CLOUDFRONT_KEY_PAIR_ID=K1234567890
CLOUDFRONT_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----...

# S3
S3_RECORDINGS_BUCKET=playhub-recordings-eu-west-2
```

### CloudFront Signed URL Generation

```typescript
// lib/streaming/cloudfront-signer.ts
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'

const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID!
const CLOUDFRONT_PRIVATE_KEY = process.env.CLOUDFRONT_PRIVATE_KEY!
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN!

export async function generateSignedPlaybackUrl(
  streamPath: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const url = `https://${CLOUDFRONT_DOMAIN}/${streamPath}`
  const dateLessThan = new Date(Date.now() + expiresInSeconds * 1000)

  return getSignedUrl({
    url,
    keyPairId: CLOUDFRONT_KEY_PAIR_ID,
    privateKey: CLOUDFRONT_PRIVATE_KEY,
    dateLessThan: dateLessThan.toISOString(),
  })
}

// Generate signed cookie for entire stream (allows all segments)
export function generateSignedCookies(
  streamPrefix: string,
  expiresInSeconds: number = 3600
): {
  'CloudFront-Policy': string
  'CloudFront-Signature': string
  'CloudFront-Key-Pair-Id': string
} {
  // ... implementation for cookie-based signing
  // Better for HLS as it covers all .ts segments
}
```

### AWS MediaLive Client

```typescript
// lib/streaming/medialive-client.ts
import {
  MediaLiveClient,
  CreateChannelCommand,
  CreateInputCommand,
  StartChannelCommand,
  StopChannelCommand,
  DeleteChannelCommand,
  DeleteInputCommand,
} from '@aws-sdk/client-medialive'

const client = new MediaLiveClient({ region: process.env.AWS_REGION })

export interface StreamResources {
  channelId: string
  channelArn: string
  inputId: string
  inputArn: string
  rtmpUrl: string
  streamKey: string
}

// Create MediaLive input (RTMP push)
export async function createInput(streamId: string): Promise<{
  inputId: string
  inputArn: string
  rtmpUrl: string
  streamKey: string
}> {
  const streamKey = `stream-${streamId}`

  const command = new CreateInputCommand({
    Name: `playhub-input-${streamId}`,
    Type: 'RTMP_PUSH',
    Destinations: [{ StreamName: streamKey }],
    Tags: {
      PlayhubStreamId: streamId,
    },
  })

  const response = await client.send(command)

  // Extract RTMP endpoint from response
  const rtmpUrl = response.Input?.Destinations?.[0]?.Url || ''

  return {
    inputId: response.Input?.Id || '',
    inputArn: response.Input?.Arn || '',
    rtmpUrl,
    streamKey,
  }
}

// Create MediaLive channel
export async function createChannel(
  streamId: string,
  inputId: string,
  mediaPackageChannelId: string
): Promise<{ channelId: string; channelArn: string }> {
  const command = new CreateChannelCommand({
    Name: `playhub-channel-${streamId}`,
    RoleArn: process.env.MEDIALIVE_ROLE_ARN,
    InputAttachments: [
      {
        InputId: inputId,
        InputAttachmentName: 'primary',
      },
    ],
    Destinations: [
      {
        Id: 'mediapackage',
        MediaPackageSettings: [{ ChannelId: mediaPackageChannelId }],
      },
      {
        Id: 's3',
        Settings: [
          {
            Url: `s3://${process.env.S3_RECORDINGS_BUCKET}/streams/${streamId}/`,
          },
        ],
      },
    ],
    EncoderSettings: {
      // Standard encoding settings for 720p + 480p + 360p
      VideoDescriptions: [
        {
          Name: 'video_720p',
          Width: 1280,
          Height: 720,
          CodecSettings: {
            H264Settings: {
              Bitrate: 3000000,
              FramerateControl: 'SPECIFIED',
              FramerateNumerator: 30,
              FramerateDenominator: 1,
              RateControlMode: 'CBR',
            },
          },
        },
        // ... 480p, 360p configs
      ],
      AudioDescriptions: [
        {
          Name: 'audio_aac',
          CodecSettings: {
            AacSettings: {
              Bitrate: 128000,
              SampleRate: 48000,
            },
          },
        },
      ],
      OutputGroups: [
        // HLS output to MediaPackage
        // Archive output to S3
      ],
    },
    Tags: {
      PlayhubStreamId: streamId,
    },
  })

  const response = await client.send(command)

  return {
    channelId: response.Channel?.Id || '',
    channelArn: response.Channel?.Arn || '',
  }
}

// Start channel
export async function startChannel(channelId: string): Promise<void> {
  await client.send(new StartChannelCommand({ ChannelId: channelId }))
}

// Stop channel
export async function stopChannel(channelId: string): Promise<void> {
  await client.send(new StopChannelCommand({ ChannelId: channelId }))
}

// Cleanup resources
export async function deleteStreamResources(
  channelId: string,
  inputId: string
): Promise<void> {
  await client.send(new DeleteChannelCommand({ ChannelId: channelId }))
  await client.send(new DeleteInputCommand({ InputId: inputId }))
}
```

### Access Check Middleware

```typescript
// lib/streaming/access-control.ts
import { createServerClient } from '@/lib/supabase/server'

export async function checkStreamAccess(
  streamId: string,
  userId: string | null
): Promise<{ hasAccess: boolean; reason: string }> {
  const supabase = createServerClient()

  // Fetch stream details
  const { data: stream } = await supabase
    .from('playhub_live_streams')
    .select('*')
    .eq('id', streamId)
    .single()

  if (!stream) {
    return { hasAccess: false, reason: 'Stream not found' }
  }

  // Public streams - always accessible
  if (stream.access_type === 'public') {
    return { hasAccess: true, reason: 'Public stream' }
  }

  // Group unlocked - anyone can access
  if (stream.access_type === 'group_unlock' && stream.is_unlocked) {
    return { hasAccess: true, reason: 'Stream unlocked by sponsor' }
  }

  // Private link - no auth required, just valid link
  if (stream.access_type === 'private_link') {
    return { hasAccess: true, reason: 'Valid private link' }
  }

  // Paid access - check user's access rights
  if (!userId) {
    return { hasAccess: false, reason: 'Authentication required' }
  }

  const { data: access } = await supabase
    .from('playhub_stream_access')
    .select('*')
    .eq('stream_id', streamId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()

  if (access) {
    // Check expiry
    if (access.expires_at && new Date(access.expires_at) < new Date()) {
      return { hasAccess: false, reason: 'Access expired' }
    }
    return { hasAccess: true, reason: 'Purchased access' }
  }

  return { hasAccess: false, reason: 'Purchase required' }
}
```

### HLS.js Video Player Component

```tsx
// components/streaming/LivePlayer.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

interface LivePlayerProps {
  playbackUrl: string // Signed CloudFront HLS URL
  isLive?: boolean
  onError?: (error: string) => void
}

export function LivePlayer({ playbackUrl, isLive, onError }: LivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [quality, setQuality] = useState<string>('auto')

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false, // Set true for lower latency
        backBufferLength: 90, // DVR buffer (90 seconds)
      })

      hlsRef.current = hls
      hls.loadSource(playbackUrl)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        setIsLoading(false)
        // Auto-play if allowed
        video.play().catch(() => {
          // Autoplay blocked - user needs to click play
        })
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad() // Try to recover
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError()
              break
            default:
              onError?.(data.details)
              break
          }
        }
      })

      return () => {
        hls.destroy()
      }
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = playbackUrl
      video.addEventListener('loadedmetadata', () => {
        setIsLoading(false)
        video.play()
      })
    }
  }, [playbackUrl, onError])

  return (
    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white" />
        </div>
      )}

      <video ref={videoRef} className="w-full h-full" controls playsInline />

      {isLive && (
        <div className="absolute top-4 left-4 bg-red-600 text-white px-2 py-1 rounded text-sm font-medium flex items-center gap-2">
          <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
          LIVE
        </div>
      )}
    </div>
  )
}
```

### Stream Lifecycle: Spiideo Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STREAM SETUP WORKFLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Organization creates stream in PLAYHUB                                  │
│     └─> Stores metadata in playhub_live_streams                             │
│     └─> Status: 'scheduled'                                                 │
│                                                                              │
│  2. Organization clicks "Provision Stream"                                   │
│     └─> Lambda creates MediaLive Input → gets RTMP URL + Key               │
│     └─> Lambda creates MediaLive Channel → links to MediaPackage + S3      │
│     └─> Stores AWS resource IDs in database                                 │
│                                                                              │
│  3. Organization enters credentials into Spiideo Play:                       │
│     ┌──────────────────────────────────────────────────────┐                │
│     │  Spiideo Play > Broadcasts > Add New Broadcast        │                │
│     │  ├─ Select "External Video Service"                   │                │
│     │  ├─ RTMP URL: rtmp://<medialive-endpoint>/live       │                │
│     │  └─ Stream Key: stream-<uuid>                        │                │
│     └──────────────────────────────────────────────────────┘                │
│                                                                              │
│  4. Before match: Organization clicks "Start Stream" in PLAYHUB             │
│     └─> Starts MediaLive channel                                            │
│     └─> Status: 'live'                                                      │
│                                                                              │
│  5. Match starts, Spiideo broadcasts to MediaLive                           │
│     └─> MediaLive transcodes to 720p/480p/360p                             │
│     └─> HLS output to MediaPackage (live playback)                         │
│     └─> Archive output to S3 (raw recording)                               │
│                                                                              │
│  6. Viewers access stream via PLAYHUB                                        │
│     └─> Access check → Generate signed CloudFront URL → HLS.js player      │
│                                                                              │
│  7. Match ends, Organization clicks "Stop Stream"                            │
│     └─> Stops MediaLive channel                                             │
│     └─> Status: 'ended'                                                     │
│     └─> Recording available in S3                                           │
│                                                                              │
│  8. (Optional) Cleanup AWS resources after 24 hours                          │
│     └─> Delete MediaLive channel + input                                    │
│     └─> Keep S3 recording for VOD + future AI                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## S3 Recording Structure

```
s3://playhub-recordings-eu-west-2/
└── streams/
    └── <stream-uuid>/
        ├── hls/
        │   ├── master.m3u8           # Master playlist
        │   ├── 720p/
        │   │   ├── playlist.m3u8     # 720p playlist
        │   │   └── segment_*.ts      # 720p segments
        │   ├── 480p/
        │   │   └── ...
        │   └── 360p/
        │       └── ...
        └── metadata.json             # Stream metadata
```

### Future AI Processing

With raw HLS segments in S3, you can later:

1. Run highlight detection ML models
2. Extract specific clips
3. Generate thumbnails
4. Create automated highlight reels
5. Process at original quality

---

## Security Considerations

1. **RTMP Key Protection**: Stream keys stored encrypted, only shown once to broadcaster
2. **Signed URLs**: All CloudFront requests require valid signature
3. **Token Expiry**: Playback URLs expire after 1 hour, require refresh
4. **S3 Access**: Recording bucket not public, accessed via CloudFront only
5. **IAM Roles**: Least-privilege access for MediaLive, Lambda

---

## Success Metrics

1. **Stream Reliability**: 99.5% uptime during scheduled broadcasts
2. **Latency**: <15 second glass-to-glass delay
3. **Quality**: Adaptive bitrate serving 720p to most viewers
4. **Recording Availability**: Available in S3 within minutes of stream end
5. **Cost Efficiency**: <£0.10 per viewer per stream

---

## Implementation Progress (December 2024)

### Completed

#### Phase 1: AWS Infrastructure Setup

- [x] S3 bucket created (`playhub-recordings-eu-west-2`)
- [x] IAM role for MediaLive (`playhub-medialive-role`)
- [x] MediaPackage channel created (`playhub-live-channel`)
- [x] MediaPackage HLS endpoint configured
- [ ] CloudFront distribution (using MediaPackage URL directly for now)

#### Phase 2-3: Stream Management API

- [x] `/api/streams/[id]/provision` - Creates MediaLive input + channel
- [x] `/api/streams/[id]/start` - Starts MediaLive channel
- [x] `/api/streams/[id]/stop` - Stops MediaLive channel
- [x] `/api/streams/test-medialive` - Connection testing endpoint

#### Spiideo Integration

- [x] Spiideo API client with OAuth2 authentication
- [x] Create/update/delete games via API
- [x] Schedule recordings with push stream output
- [x] Venue management page (`/venue`) for easy scheduling

### Key Findings

#### RTMP URL Format (Critical)

MediaLive RTMP inputs require standard format: `rtmp://host:port/app/streamkey`

**Initial issue**: We created inputs with `StreamName: stream-${streamId}` which produced URLs like `rtmp://ip:1935/stream-uuid` (no app name). Spiideo showed "Error" on the output.

**Solution**: Changed to `StreamName: live/${streamId}` which produces:

- RTMP URL: `rtmp://ip:1935/live`
- Stream Key: `uuid`

This standard format works correctly with Spiideo's push stream output.

#### MediaPackage H264 Settings

MediaLive channels outputting to MediaPackage require explicit pixel aspect ratio settings:

```typescript
CodecSettings: {
  H264Settings: {
    // ... other settings
    ParControl: 'SPECIFIED',
    ParNumerator: 1,
    ParDenominator: 1,
  }
}
```

Without this, channel creation fails with validation error.

#### DVR/Time-Shift

Current MediaPackage configuration is **live-only** - viewers can only see the current live stream, not rewind. This is expected behavior.

**For PLAYHUB's marketplace model**: VOD from S3 recordings is the primary use case. DVR during live is a nice-to-have but adds cost/complexity.

#### Channel Lifecycle Timing

- **Provisioning**: ~5 seconds
- **Starting**: ~1-2 minutes to transition IDLE → RUNNING
- **Stopping**: ~1-2 minutes to transition RUNNING → STOPPING → IDLE
- **Cost**: MediaLive charges while channel is RUNNING (~$0.75-3/hr)

### Architecture (Verified Working)

```
Spiideo Camera → RTMP Push → MediaLive Input → MediaLive Channel
                                                      │
                                    ┌─────────────────┴─────────────────┐
                                    │                                   │
                                    ▼                                   ▼
                            MediaPackage                         S3 Archive
                            (Live HLS)                          (Recording)
                                    │
                                    ▼
                              HLS Playback
              https://...mediapackage.../out/v1/.../index.m3u8
```

### Environment Variables (Working)

```bash
# AWS
AWS_REGION=eu-west-2
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
MEDIALIVE_ROLE_ARN=arn:aws:iam::xxx:role/playhub-medialive-role
MEDIAPACKAGE_CHANNEL_ID=playhub-live-channel
MEDIAPACKAGE_HLS_URL=https://xxx.mediapackage.eu-west-2.amazonaws.com/out/v1/xxx/index.m3u8
S3_RECORDINGS_BUCKET=playhub-recordings-eu-west-2

# Spiideo
SPIIDEO_KUWAIT_CLIENT_ID=xxx
SPIIDEO_KUWAIT_CLIENT_SECRET=xxx
s=xxx
SPIIDEO_KUWAIT_ACCOUNT_ID=xxx
SPIIDEO_KUWAIT_SCENE_ID=xxx
SPIIDEO_KUWAIT_RECIPE_ID=xxx
```

---

## Next Steps

1. **S3 Recording VOD Workflow**
   - Process recordings after stream ends
   - Generate VOD playback URLs from S3
   - Link recordings to marketplace products

2. **CloudFront Signed URLs**
   - Set up CloudFront distribution
   - Implement signed URL generation for paywall

3. **Viewer Experience**
   - Stream listing page
   - HLS.js video player component
   - Access control integration

4. **Clean Up Old Resources**
   - Delete old MediaLive channels/inputs after streams end
   - Implement cleanup Lambda or scheduled job

---

## Resolved Questions

| Question            | Decision                                                  |
| ------------------- | --------------------------------------------------------- |
| Platform choice     | **AWS MediaLive + S3 + CloudFront** (raw files, AI-ready) |
| Concurrent viewers  | Up to 10 per stream (scalable)                            |
| DVR required        | **Yes** - via MediaPackage                                |
| Recording           | **Yes** - raw HLS to S3 for future AI                     |
| Latency requirement | ~10-15s acceptable                                        |
| Raw file retention  | **Yes** - S3 storage, you own the files                   |

---

## Sources

- [Spiideo RTMP/SRT Documentation](https://support.spiideo.com/en/articles/5204129-stream-via-rtmp-srt-to-your-platform)
- [AWS MediaLive Pricing](https://aws.amazon.com/medialive/pricing/)
- [AWS MediaPackage Documentation](https://docs.aws.amazon.com/mediapackage/)
- [CloudFront Signed URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html)
- [AWS Live Streaming Solution](https://aws.amazon.com/solutions/implementations/live-streaming-on-aws/)
