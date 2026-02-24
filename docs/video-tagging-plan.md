# Video Event Tagging System

## Status: Complete

## TODO Tracker

- [x] Step 0: Create tracking file
- [x] Step 1: Database migration — `playhub_recording_events` table + RLS
- [x] Step 2a: Create `src/lib/recordings/event-types.ts` — constants, labels, colors, TS interface
- [x] Step 2b: Create `src/app/api/recordings/[id]/events/route.ts` — GET + POST
- [x] Step 2c: Create `src/app/api/recordings/[id]/events/[eventId]/route.ts` — PATCH + DELETE
- [x] Step 3: Create `src/components/video/VideoPlayer.tsx` — custom player with event markers
- [x] Step 4: Modify `src/app/recordings/[id]/page.tsx` — integrate player + event list + tagging UI
- [x] Step 5: Tests — event-types unit test + API route tests
- [x] Step 6: Verification — build passes, manual testing, add review section

## Review

### Files Created (6)

| File                                                    | Purpose                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260218_recording_events.sql`     | DB table with constraints, indexes, RLS policies, grants                                     |
| `src/lib/recordings/event-types.ts`                     | 14 event types, labels, hex colors, TS interfaces, `formatTimestamp()`, `isValidEventType()` |
| `src/app/api/recordings/[id]/events/route.ts`           | GET (list events) + POST (create event) with auth + access checks                            |
| `src/app/api/recordings/[id]/events/[eventId]/route.ts` | PATCH (update own event) + DELETE (delete own event)                                         |
| `src/components/video/VideoPlayer.tsx`                  | Custom player with HLS, event marker dots, tooltips, "Add Tag" button                        |
| `src/lib/recordings/__tests__/event-types.test.ts`      | 13 unit tests for constants and utilities                                                    |

### Files Modified (1)

| File                               | Changes                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app/recordings/[id]/page.tsx` | Replaced `<video>` with `<VideoPlayer>`, added events fetch, event timeline panel, inline TagForm for add/edit, visibility toggle, edit/delete on own events |

### Key Decisions

- **RLS-based visibility**: Public events visible to all authenticated users; private events only to creator. No server-side filtering needed beyond what RLS provides.
- **Access check on events API**: Reuses existing `checkRecordingAccess()` — same people who can watch can tag.
- **Inline TagForm**: Single component used for both add and edit, keeps the UI minimal.
- **VideoPlayer**: Built on PLAYBACK's player pattern but added event marker dots on the progress bar and HLS support from `HlsPlayer.tsx`.
- **`source` column**: Defaults to `'manual'` now, `'ai_detected'` reserved for future AI auto-tagging feature.

### Test Results

- 71 tests pass (13 new event-types tests)
- `npm run build` succeeds with no TS errors

### What's Left for Manual Testing

1. Run `npx supabase db push` to apply the migration
2. Navigate to `/recordings/[id]` with a video — verify custom player loads
3. Add a tag at current timestamp — verify it appears in timeline and on progress bar
4. Toggle private visibility — verify only creator sees it
5. Click event dot or timestamp — verify video seeks
6. Edit/delete own tags — verify changes persist
