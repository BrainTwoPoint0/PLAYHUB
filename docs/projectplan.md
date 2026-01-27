# Spiideo + MediaLive Integration Plan

## Goal
Enable venue admins to schedule streams that automatically connect Spiideo cameras to PLAYHUB's MediaLive RTMP endpoint, allowing seamless live streaming from Spiideo cameras through our platform.

## Current State
- **MediaLive**: Working - can create channels, get RTMP URLs, start/stop streams
- **Spiideo Client**: Full API integration exists with `setupLiveBroadcast()` function
- **Venue Page**: Has streaming section with channel creation, but no Spiideo integration

## Workflow
1. Venue admin selects a Spiideo scene (camera/pitch)
2. Admin schedules a stream (selects existing Spiideo game OR creates new one)
3. System creates MediaLive channel with RTMP input
4. System creates Spiideo production with `push_stream` output to MediaLive RTMP URL
5. When stream starts, Spiideo camera pushes video to MediaLive
6. MediaLive processes and sends to MediaPackage for HLS playback

## Implementation Tasks

### Phase 1: API Endpoints
- [ ] Create `/api/streaming/spiideo/connect` - Connect Spiideo game to MediaLive channel
  - Takes: gameId, channelId (or creates new channel)
  - Creates Spiideo production with push_stream output
  - Returns: channel info + Spiideo production info

### Phase 2: Venue Page UI Updates
- [ ] Add Spiideo game selector to streaming section
  - Dropdown to select from existing scheduled Spiideo games
  - Show game title, date, scene name
- [ ] Add "Connect Spiideo" button for each channel
  - Opens modal to select Spiideo game
  - Calls API to set up the connection
- [ ] Show connection status (Spiideo game linked to channel)
- [ ] Add ability to disconnect Spiideo from channel

### Phase 3: Simplified Flow (Optional)
- [ ] "Quick Stream" button that does everything in one click:
  - Creates MediaLive channel
  - Creates Spiideo production with push_stream output
  - Starts the channel
  - Returns playback URL

## API Design

### POST /api/streaming/spiideo/connect
```typescript
Request:
{
  gameId: string,        // Spiideo game ID
  channelId?: string,    // Existing channel ID (optional - creates new if not provided)
  channelName?: string,  // Name for new channel (if creating)
  venueId: string
}

Response:
{
  channel: {
    id: string,
    name: string,
    rtmpUrl: string,
    playbackUrl: string
  },
  spiideo: {
    productionId: string,
    outputId: string,
    gameId: string
  }
}
```

## Files to Modify
1. `src/app/api/streaming/spiideo/connect/route.ts` (new)
2. `src/app/venue/[venueId]/page.tsx` - Add Spiideo integration to streaming section

## Questions for Review
1. Should we auto-start the channel when Spiideo is connected?
2. Should we store the Spiideo-MediaLive connection in the database for tracking?
3. Which Spiideo account (Kuwait/Dubai) should be used per venue?

---

## Review - Spiideo Integration (Completed)
- Created `/api/streaming/spiideo/connect` endpoint
- Added single-step scheduling UI to venue page
- Fixed stream key length issue (shortened to 8 chars)
- Fixed RTMP URL format (`/live/stream-key`)
- Full flow tested and working

---

# Gotcha Feedback Integration Plan

## Overview
Integrate gotcha-feedback (gotcha.cx) SDK to collect contextual user feedback across PLAYHUB.

## Feedback Locations & Modes

| Location | Component | Feedback Mode | Trigger |
|----------|-----------|---------------|---------|
| Video Player | `watch/[token]/page.tsx` | 5-star rating | Below video player |
| Purchase Success | `purchase/success/page.tsx` | Thumbs up/down | On page (post-purchase) |
| Match Detail | `matches/[id]/page.tsx` | Thumbs up/down | On match info card |
| Browse Page | `matches/page.tsx` | 5-star rating | Footer (search experience) |

## Implementation Tasks

- [ ] 1. Install gotcha-feedback package
- [ ] 2. Create GotchaProvider wrapper component
- [ ] 3. Add GotchaProvider to root layout
- [ ] 4. Add feedback to video player (5-star)
- [ ] 5. Add feedback to purchase success page (thumbs)
- [ ] 6. Add feedback to match detail page (thumbs)
- [ ] 7. Add feedback to browse page (5-star)
- [ ] 8. Test all feedback points

## Environment Variables Required
```
NEXT_PUBLIC_GOTCHA_PROJECT_ID=your-project-id
```

---

Ready for review before implementation.
