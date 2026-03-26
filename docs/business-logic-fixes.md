# Business Logic & Flow Fixes — Project Plan

**Date**: 2026-03-10
**Source**: 4 independent audit agents + user-reported venue manager issue

---

## Immediate Action: amoperation@suffix.com Rate Limit

**Problem**: Venue manager clicked "Sign in" many times rapidly on their phone. Each click hit Supabase's auth rate limit (429). Eventually one click succeeded and they were redirected to homepage — but the login page still showed "rate limit reached" on subsequent visits from that device. They could see "Manage Venue" and "Manage Org" in the navbar (meaning auth succeeded) but still had the sign in/sign up page content visible.

**Root cause**: Device-specific. Supabase rate limits are per-IP/per-device. The phone browser has stale cookies/cached error state. Confirmed by testing the same email+password from a different phone — works fine.

**Fix for the user**: Tell them to clear browser cookies/cache for playhub.playbacksports.ai on their phone, or use incognito/private mode.

**Fix for the app**: See items P1-8 and P2-1 below.

---

## Priority Tiers

- **P0** — Broken functionality (users affected right now)
- **P1** — Data integrity / money-taken-no-access risks
- **P2** — UX gaps and defensive hardening
- **P3** — Consistency and cleanup

---

## P0: Broken Functionality

### [x] P0-1: Share "Save to Library" button is completely broken

**Files**: `src/app/watch/[token]/page.tsx:117`
**Problem**: `handleSave` sends an empty POST body to `/api/recordings/{id}/save`, but the endpoint requires `{ token }` in the body. Every save attempt silently returns 400 — no user feedback.
**Fix**:

- Pass `{ token }` in the POST body (token is already in scope from `useParams()`)
- Add `Content-Type: application/json` header
- Show error feedback to the user instead of `catch { // Silently fail }`

### [x] P0-2: Register page ignores redirect parameter

**Files**: `src/app/auth/register/page.tsx:153`
**Problem**: After successful signup, unconditionally does `router.push('/')`. Login page correctly reads `redirect` param, but register page ignores it. All invite emails link to `/auth/register` with no redirect param anyway.
**Fix**:

- Read `searchParams.get('redirect')` in register page (same pattern as login)
- Apply same open-redirect validation (`startsWith('/')`, not `//`, no `@`, no `\\`)
- Redirect to the safe path after successful signup

### [x] P0-3: Login-to-register link drops redirect context

**Files**: `src/app/auth/login/page.tsx:170`
**Problem**: "Sign up" link on login page is hardcoded to `/auth/register` — doesn't forward the `redirect` query param.
**Fix**: Change to `/auth/register?redirect=${encodeURIComponent(redirect)}` when redirect param exists.

### [x] P0-4: Email invite links have no redirect context

**Files**: `src/lib/email/index.ts:48, 92`
**Problem**: Admin invite email and recording access email both link to `${APP_URL}/auth/register` with no query params. After signup, user lands on homepage with no context.
**Fix**:

- Admin invite: link to `/auth/register?redirect=/venue` (or `/academy` for academy invites)
- Recording access: link to `/auth/register?redirect=/recordings`

---

## P1: Data Integrity & Payment Safety

### [x] P1-1: Remove redundant `processPendingAdminInvites` from `/api/venue`

**Files**: `src/app/api/venue/route.ts:44-46, 115-162`
**Problem**: DB trigger `handle_new_user` now processes pending invites on signup. The app-level function still runs on every `GET /api/venue` call, racing with the trigger. No `ON CONFLICT` on the insert creates duplicate key violation risk.
**Fix**: Delete the `processPendingAdminInvites` function and the call at line 44-46. The DB trigger is the single source of truth for invite processing.

### [x] P1-2: Guard empty `profile_id` in checkout session

**Files**: `src/app/api/checkout/session/route.ts:86`
**Problem**: If profile lookup returns null, `profile?.id || ''` stores empty string in Stripe metadata. Webhook then tries to insert `profile_id: ''` into `playhub_purchases` — FK violation, money taken, no access.
**Fix**: If profile is null, return 400 error before creating checkout session.

```typescript
if (!profile) {
  return NextResponse.json(
    { error: 'Profile not found. Please try again.' },
    { status: 400 }
  )
}
```

### [x] P1-3: Unify access checking — `profile_id` vs `user_id` vs `invited_email`

**Files**: `src/app/matches/[id]/page.tsx:54`, `src/lib/recordings/access-control.ts:216`, `src/app/api/webhooks/stripe/route.ts:244`
**Problem**: Three different columns are used to check/grant access:

- Match detail page queries by `profile_id`
- `checkRecordingAccess` queries by `user_id`
- Webhook inserts with `profile_id` only (no `user_id`)
- Venue booking inserts with `invited_email` only

Result: purchased recordings show as locked in some views, venue bookings show as locked in others.
**Fix**:

- Webhook `handleMatchRecordingPurchase`: also set `user_id` when inserting access rights
- Match detail page: use `checkRecordingAccess` API instead of inline query, OR query both `profile_id` and `user_id`
- Long-term: standardize on `user_id` as the primary access identifier

### [x] P1-4: Match detail page uses `getSession()` (no JWT verification)

**Files**: `src/app/matches/[id]/page.tsx:37`
**Problem**: `getSession()` doesn't verify the JWT. A crafted cookie could impersonate another user's access status.
**Fix**: Replace with `getAuthUser()` which verifies the JWT.

### [x] P1-5: Spiideo recording DB insert failure is swallowed

**Files**: `src/lib/spiideo/schedule-recording.ts:134-163`
**Problem**: If DB insert fails after Spiideo game is created, the function returns success. User paid, Spiideo records, but no DB record = no access link.
**Fix**: If `recordingError` is truthy, throw an error so the webhook returns 500 and Stripe retries.

### [x] P1-6: Webhook returns 400/500 on unrecoverable errors

**Files**: `src/app/api/webhooks/stripe/route.ts`
**Problem**: Stripe retries for 72 hours on non-2xx responses. Unrecoverable errors (FK violations, missing data) cause infinite retries while money is already taken.
**Fix**: For clearly unrecoverable errors (missing metadata, FK violations), log the error with full context but return 200 to acknowledge receipt. Consider adding an error tracking/alerting mechanism.

### [x] P1-7: Timing-safe API key comparison missing in 3 endpoints

**Files**: `src/app/api/recordings/route.ts:21`, `src/app/api/veo/recordings/route.ts:6`, `src/app/api/academy/[clubSlug]/veo/sync/route.ts:21`
**Problem**: These use `===` string comparison instead of `timingSafeEqual`. The sync endpoint already does it correctly.
**Fix**: Use the same `timingSafeEqual` pattern from `api/recordings/sync/route.ts`.

### [x] P1-8: Webhook `handleMatchRecordingPurchase` doesn't set `user_id` on access_rights

**Files**: `src/app/api/webhooks/stripe/route.ts:244-250`
**Problem**: Insert into `playhub_access_rights` sets `profile_id` and `match_recording_id` but never `user_id`. The `checkRecordingAccess` function queries by `user_id`, so purchased recordings are invisible to the access control system.
**Fix**: Include `user_id` (from session metadata) in the access rights insert.

---

## P2: UX & Defensive Hardening

### [x] P2-1: Add login rate limit protection (prevents the amoperation issue)

**Files**: `src/app/auth/login/page.tsx`, `src/app/auth/register/page.tsx`
**Problem**: No client-side rate limiting. Users can spam the sign-in button as fast as they click, hitting Supabase's server-side rate limit and getting into a broken state on their device.
**Fix**:

- Disable the submit button for 2 seconds after each attempt (simple debounce)
- After 3 consecutive errors, show a "Please wait 30 seconds before trying again" countdown
- On 429/rate-limit error specifically, show: "Too many sign-in attempts. Please wait a minute and try again."
- Same treatment for register page

### [x] P2-2: Prevent authenticated users from seeing login/register pages

**Files**: `src/app/auth/login/page.tsx:33-40`, `src/app/auth/register/page.tsx`
**Problem**: The login page has a `useEffect` that redirects if `user` exists, but there's a flash where the login form is visible while auth state initializes. If auth state flickers (rate limit then success), user sees both the navbar (authenticated) and the login form content.
**Fix**: Show a loading spinner while `loading` is true from `useAuth()`. Only render the form when `loading === false && !user`. This prevents the flash of login form for authenticated users.

### [x] P2-3: Email template says "venue admin" for all org types

**Files**: `src/lib/email/index.ts:45`
**Problem**: Academy and org invites use the same template with hardcoded "venue" language.
**Fix**: Accept an `orgType` parameter and adjust the email copy. "As an admin, you'll be able to manage recordings, access, and invite other admins."

### [x] P2-4: Admin removal should clean up pending invites

**Files**: `src/app/api/venue/[venueId]/admins/[memberId]/route.ts`, `src/app/api/academy/[clubSlug]/admins/[memberId]/route.ts`
**Problem**: Removing an admin leaves stale rows in `playhub_pending_admin_invites`. Could cause re-addition if the soft-deleted membership row is ever hard-deleted.
**Fix**: On admin DELETE, also delete any `playhub_pending_admin_invites` rows for that email + organization_id.

### [x] P2-5: Purchase success page claims email was sent (none is)

**Files**: `src/app/purchase/success/page.tsx:85`
**Problem**: Says "A confirmation email has been sent" but no email is actually sent.
**Fix**: Remove the false claim.

### [x] P2-6: Purchase success page should link to the purchased content

**Files**: `src/app/purchase/success/page.tsx:75-81`
**Problem**: Only offers "Browse More Matches" and "Go Home" — no direct link to the purchased recording.
**Fix**: Retrieve `match_recording_id` from the Stripe session metadata and add a "Watch Now" button.

### [x] P2-7: Orphaned S3 objects when DB insert fails during sync

**Files**: `src/app/api/recordings/sync/route.ts:338-372`
**Problem**: S3 upload succeeds, DB fails, no cleanup. Leaks storage costs over time.
**Fix**: If DB upsert fails, attempt to delete the S3 object. Log if S3 cleanup also fails.

---

## P3: Consistency & Cleanup

### [x] P3-1: `manager` role is a black hole

**Files**: Multiple admin routes
**Problem**: `manager` role can be assigned via POST but is never queried by GET endpoints, nav route, or `isVenueAdmin`. Users with `manager` role are invisible and have no permissions.
**Fix**: Either remove `manager` from POST acceptance whitelists, OR add `manager` to all GET/nav queries.

### [x] P3-2: Pending invite visibility inconsistency

**Problem**: Org team GET returns both `admins` and `pendingInvites`. Venue and academy GET endpoints only return active admins.
**Fix**: Add pending invite listing to venue and academy admin GET endpoints for parity.

### [x] P3-3: Verify `playhub_recording_access` vs `playhub_access_rights` tables

**Problem**: Two migration files create two different tables. All code queries `playhub_access_rights`. Need to verify in Supabase whether `playhub_recording_access` exists and has data.
**Fix**: Verified — no code or migration files reference `playhub_recording_access`. All code uses `playhub_access_rights`. If the table exists in Supabase, it can be safely dropped.

### [x] P3-4: `/api/recordings/share/[id]` redirect is broken

**Files**: `src/app/api/recordings/share/[id]/route.ts:12`
**Problem**: Redirects to `/recordings/{id}` (authenticated page) instead of `/watch/{token}` (public share page).
**Fix**: Look up the recording by share token and redirect to `/watch/{token}`, or remove this endpoint if unused.

### [ ] P3-5: Academy admin management requires platform admin (inconsistent with venue)

**Problem**: Venue admins can self-manage their admin team. Academy admins cannot (requires `isPlatformAdmin`).
**Fix**: Product decision needed — should academy org admins manage their own admins?

### [x] P3-6: Recording list endpoint uses RLS client after access check

**Files**: `src/app/api/recordings/route.ts:87`
**Problem**: After `checkRecordingAccess` confirms access (service client), the data fetch uses the user's RLS client which may deny the query.
**Fix**: Use `createServiceClient()` for the data fetch after access is confirmed.

---

## Summary

| Priority  | Count  | Description                      |
| --------- | ------ | -------------------------------- |
| P0        | 4      | Broken flows users hit right now |
| P1        | 8      | Money/data integrity risks       |
| P2        | 7      | UX gaps and hardening            |
| P3        | 6      | Consistency and cleanup          |
| **Total** | **25** |                                  |

---

## Review

_To be filled after implementation._
