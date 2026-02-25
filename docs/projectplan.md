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

| Location         | Component                   | Feedback Mode  | Trigger                    |
| ---------------- | --------------------------- | -------------- | -------------------------- |
| Video Player     | `watch/[token]/page.tsx`    | 5-star rating  | Below video player         |
| Purchase Success | `purchase/success/page.tsx` | Thumbs up/down | On page (post-purchase)    |
| Match Detail     | `matches/[id]/page.tsx`     | Thumbs up/down | On match info card         |
| Browse Page      | `matches/page.tsx`          | 5-star rating  | Footer (search experience) |

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

---

# Move Veo Playwright Scraping into Lambda

## Goal

Move Playwright-based Veo ClubHouse scraping from PLAYHUB (Netlify) into an AWS Lambda function. Netlify serverless functions can't run Playwright (~400MB Chromium binary). The Lambda scrapes Veo directly and writes results to Supabase.

## Architecture

```
Before:  Lambda → HTTP POST → Netlify cache-sync → Playwright → Veo → Supabase
After:   Lambda → Playwright (playwright-core + @sparticuz/chromium) → Veo → Supabase (direct)
         PLAYHUB cache-sync endpoint → invokes Lambda via AWS SDK (async)
```

## Implementation Tasks

- [x] Create `infrastructure/lambda/veo-sync/veo-scraper.ts` — Playwright scraper using `playwright-core` + `@sparticuz/chromium`
- [x] Create `infrastructure/lambda/veo-sync/cache-writer.ts` — Standalone Supabase client for writing cache data
- [x] Create `infrastructure/lambda/veo-sync/config.ts` — Club slug → Veo slug mapping
- [x] Update `infrastructure/lambda/veo-sync/index.ts` — Direct scraping instead of HTTP call, single-club support
- [x] Update `infrastructure/lambda/veo-sync/package.json` — Add playwright-core, @sparticuz/chromium, @supabase/supabase-js
- [x] Update `infrastructure/terraform/veo-sync-lambda.tf` — 2048MB memory, 300s timeout, new env vars
- [x] Create Lambda Layer for @sparticuz/chromium (65MB, uploaded via S3)
- [x] Rewrite `src/app/api/academy/[clubSlug]/veo/cache-sync/route.ts` — Invoke Lambda via `@aws-sdk/client-lambda` (async)
- [x] Update `src/app/academy/[clubSlug]/access/page.tsx` — Poll after async Lambda invocation
- [x] Add `"infrastructure"` to `tsconfig.json` exclude to prevent Next.js compiling Lambda files
- [x] Fix retry bug in veo-scraper.ts — `return null` instead of `throw` for retry loop
- [x] Fix memory: bumped Lambda from 1024MB to 2048MB (Chromium needs ~900MB)
- [x] Fix Netlify env var: `STRIPE_SECRET_KEY` was set to test key instead of live key
- [x] Add granular error reporting to GET endpoint for production debugging

## Files Created

- `infrastructure/lambda/veo-sync/veo-scraper.ts`
- `infrastructure/lambda/veo-sync/cache-writer.ts`
- `infrastructure/lambda/veo-sync/config.ts`

## Files Modified

- `infrastructure/lambda/veo-sync/index.ts`
- `infrastructure/lambda/veo-sync/package.json`
- `infrastructure/terraform/veo-sync-lambda.tf`
- `src/app/api/academy/[clubSlug]/veo/cache-sync/route.ts`
- `src/app/api/academy/[clubSlug]/veo/route.ts`
- `src/app/academy/[clubSlug]/access/page.tsx`
- `src/lib/veo/cache.ts`
- `tsconfig.json`
- `package.json` (added @aws-sdk/client-lambda)

## Key Decisions

1. **`playwright-core` + `@sparticuz/chromium`** — Lambda-compatible Chromium (~50MB compressed) vs full Playwright (~400MB)
2. **Lambda Layer** — Chromium binary in a separate layer (65MB zip, uploaded via S3) to keep function code small (~2.5MB)
3. **Async invocation** — `InvocationType: 'Event'` avoids Netlify's 26s function timeout; frontend polls for completion
4. **2048MB Lambda memory** — Chromium requires ~900MB at peak; 1024MB caused `ERR_INSUFFICIENT_RESOURCES`
5. **CloudWatch Alarm + SNS** — Alerts admin@playbacksports.ai when Lambda fails

## Bugs Encountered & Fixed

| Bug | Cause | Fix |
|-----|-------|-----|
| Retry loop bypassed | `throw` instead of `return null` when tokens not captured | Changed to `return null` with warning log |
| `ERR_INSUFFICIENT_RESOURCES` | 1024MB Lambda not enough for Chromium | Bumped to 2048MB |
| Netlify build failure | TypeScript compiled Lambda files importing `@sparticuz/chromium` | Added `"infrastructure"` to tsconfig exclude |
| 500 on GET endpoint | `STRIPE_SECRET_KEY` on Netlify was set to test key | User updated Netlify env var to live key |
| Lambda Function URL 403 | AWS account blocks public Lambda Function URLs | Switched to `@aws-sdk/client-lambda` direct invocation |

## Verification

- Lambda successfully syncs CFA (6 teams, 81 members) and SEFA (13 teams, 136 members)
- "Sync Now" button invokes Lambda via AWS SDK, frontend polls until data refreshes
- CloudWatch alarm emails admin@playbacksports.ai on Lambda failures
- Production page loads at `https://playhub.playbacksports.ai/academy/sefa/access`

---

# Veo Privacy Sync

## Goal

Make all Veo ClubHouse recordings private. Exception: SEFA U19 (`Soccer Elite FA U19`) recordings stay public.

## Approach

Added a `privacy-sync` action to the existing `playhub-veo-sync` Lambda. Reuses existing Playwright auth and session infrastructure. No daily schedule — Veo now has built-in club privacy settings, so this is a manual-only tool.

## Implementation Tasks

- [x] Add `listClubRecordings()` to `veo-scraper.ts` — fetches all recordings for a club via `/api/app/clubs/{slug}/recordings/` with pagination
- [x] Add `setMatchPrivacy()` to `veo-scraper.ts` — PATCHes a recording's privacy setting
- [x] Add `VeoRecording` type with `team` field for filtering
- [x] Add `PUBLIC_RECORDING_TEAMS` config — maps club slugs to excepted team names
- [x] Add `runPrivacySync()` to `index.ts` — iterates recordings, skips excepted teams, PATCHes public ones to private
- [x] Route `'privacy-sync'` action in handler
- [x] Add rate limiting (1s between PATCH calls, 2s between pagination requests)
- [x] Increase body truncation limit from 50KB to 500KB (large recording lists)

## Files Modified

- `infrastructure/lambda/veo-sync/config.ts` — added `PUBLIC_RECORDING_TEAMS`
- `infrastructure/lambda/veo-sync/veo-scraper.ts` — added `VeoRecording`, `listClubRecordings()`, `setMatchPrivacy()`
- `infrastructure/lambda/veo-sync/index.ts` — added `runPrivacySync()`, handler routing
- `infrastructure/terraform/veo-sync-lambda.tf` — EventBridge schedule added then removed (Veo has built-in club privacy settings now)

## Key Decisions

1. **Club-level recordings endpoint** — per-team endpoint doesn't exist; used `/api/app/clubs/{slug}/recordings/` instead
2. **Team filtering via `team` field** — each recording has a `team` name; used this to skip SEFA U19 recordings
3. **No daily schedule** — Veo now supports club-level privacy defaults, so automated sync is unnecessary. Code kept for manual use.
4. **Rate limiting** — 1s delay between PATCHes and 2s between pages to avoid Veo rate limiting

## Execution Results

- **CFA**: 220 recordings — all set to private
- **SEFA**: 518 recordings — 319 set to private, 199 skipped (Soccer Elite FA U19)

## Manual Invocation

```bash
AWS_PROFILE=playhub aws lambda invoke --function-name playhub-veo-sync \
  --payload '{"action":"privacy-sync"}' \
  --region eu-west-2 --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 300 /tmp/result.json && cat /tmp/result.json
```
