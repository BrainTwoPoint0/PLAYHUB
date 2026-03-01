# Graphic Packages — Account-Based

**Status:** Planning

## Problem

Graphics (logos, sponsors) are currently stored as `media_pack` JSONB on `playhub_venue_billing_config` — tied to the venue. But branding belongs to the organization. When DAFL records at any venue, they should use DAFL's sponsors/logos, not the venue's.

## Current State

**In the DB:**
- `playhub_venue_billing_config.media_pack` — JSONB with `logo_url`, `logo_position`, `sponsor_logo_url`, `sponsor_position`
- Set per venue via the billing settings UI

**In the UI:**
- Venue page has a "Media Pack" section in billing settings
- `media_pack` is fetched in `/api/recordings/[id]` and `/api/watch/[token]` and passed to the video player

**Spiideo API:**
- `GET /v1/graphic-packages` — lists packages with `id`, `accountId`, `name`, `sports[]`, `type` (html/svg)
- Packages are NOT linked to productions/games in the public API
- Graphics are NOT baked into Spiideo Play downloads
- We can list packages but can't programmatically apply them to a production

## Design Decisions (Resolved)

### 1. Logo File Storage
- **PLAYHUB-managed packages** → Supabase Storage bucket `graphic-packages/`
- **Spiideo-linked packages** → URL reference to Spiideo (metadata only, assets uploaded to Supabase separately)

### 2. Position System (Learned from LIGR)
**Predefined position slots, not custom coordinates.** LIGR proves users don't want x/y control. Use percentage-based CSS positioning for responsiveness across player sizes.

| Position | CSS | Typical Use |
|----------|-----|-------------|
| `top-left` | `top: 2%; left: 2%` | Competition/league logo |
| `top-right` | `top: 2%; right: 2%` | Club/org logo |
| `bottom-left` | `bottom: 2%; left: 2%` | Sponsor logo |
| `bottom-right` | `bottom: 2%; right: 2%` | Secondary sponsor |

Logo spec: **300x300 PNG with transparent background** (LIGR standard). Sponsor banners: **510x150 PNG transparent**.

### 3. Spiideo Import
Link by Spiideo package ID for reference. Actual assets (logos, sponsors) must be uploaded to Supabase — Spiideo's API only returns metadata (name, type, sports), not the graphic files.

### 4. Overlay Rendering
**CSS overlay on the video player** — absolutely-positioned elements over `<video>`. This is how LIGR works (transparent HTML layer over video). Graphics exist in the viewing experience, not baked into the file. Simple, no server-side processing needed.

## Database Schema

### New Table: `playhub_graphic_packages`

```sql
CREATE TABLE playhub_graphic_packages (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,

  -- Logo element
  logo_url TEXT,              -- Supabase Storage path
  logo_position TEXT DEFAULT 'top-right',

  -- Sponsor element
  sponsor_logo_url TEXT,      -- Supabase Storage path
  sponsor_position TEXT DEFAULT 'bottom-left',

  -- Spiideo link (nullable)
  spiideo_graphic_package_id UUID,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT valid_logo_position CHECK (
    logo_position IN ('top-left', 'top-right', 'bottom-left', 'bottom-right')
  ),
  CONSTRAINT valid_sponsor_position CHECK (
    sponsor_position IN ('top-left', 'top-right', 'bottom-left', 'bottom-right')
  )
);

CREATE INDEX idx_graphic_packages_org ON playhub_graphic_packages(organization_id);

-- Ensure only one default per org
CREATE UNIQUE INDEX idx_graphic_packages_default
  ON playhub_graphic_packages(organization_id) WHERE is_default = true;
```

### New Column on Recordings

```sql
ALTER TABLE playhub_match_recordings
  ADD COLUMN graphic_package_id UUID REFERENCES playhub_graphic_packages(id) ON DELETE SET NULL;
```

### RLS Policies

```sql
ALTER TABLE playhub_graphic_packages ENABLE ROW LEVEL SECURITY;

-- Public can view (needed for watch page overlay)
CREATE POLICY "Anyone can view graphic packages"
  ON playhub_graphic_packages FOR SELECT USING (true);

-- Org admins/managers can manage
CREATE POLICY "Org admins can manage graphic packages"
  ON playhub_graphic_packages FOR ALL USING (
    organization_id IN (
      SELECT om.organization_id FROM organization_members om
      JOIN profiles p ON p.id = om.profile_id
      WHERE p.user_id = auth.uid() AND om.role IN ('admin', 'manager')
    )
  );
```

## How It Gets Applied

1. **When scheduling a recording** — org's default graphic package auto-attached (or user picks one)
2. **On the recording** — `playhub_match_recordings.graphic_package_id` FK
3. **When watching** — fetch graphic package from recording → fall back to org's default → fall back to venue `media_pack`
4. **Rendering** — CSS overlay on `<video>` player with `position: absolute` elements at percentage offsets

### Fallback Chain

```
recording.graphic_package_id (explicit)
  → org's default graphic package (is_default = true)
    → venue media_pack (legacy, from playhub_venue_billing_config)
      → no overlay
```

## Migration Path from Venue `media_pack`

- Keep `media_pack` on venue billing config as final fallback
- New recordings use org's graphic package
- No backfill needed — old recordings fall through to venue `media_pack`

## Implementation Tasks

### Phase 1: Database & API

- [x] Create `playhub_graphic_packages` table + RLS policies (migration SQL) → `docs/migrations/graphic_packages.sql`
- [x] Add `graphic_package_id` column to `playhub_match_recordings` → in migration
- [x] Add `getGraphicPackages()` to Spiideo client → `src/lib/spiideo/client.ts`
- [x] Create `/api/org/[slug]/graphic-packages` — CRUD endpoints → `src/app/api/org/[slug]/graphic-packages/route.ts`
- [x] Update `/api/recordings/[id]` GET — fallback chain: recording → org default → venue media_pack
- [x] Update `/api/watch/[token]` GET — same fallback logic
- [x] **Run migration SQL in Supabase** (manual step)

### Phase 2: UI — Org Graphics Management

- [x] Add "Graphic Packages" section to venue admin page (after Venue Settings)
- [x] List packages with name, logo preview thumbnail, position info, default badge
- [x] Create/edit form: name, logo URL, sponsor URL, positions (4 slots), default checkbox
- [x] Live preview panel: shows logos at selected positions on a mock video frame
- [x] Set default (one-click from list)
- [x] Delete with confirmation
- [x] Import from Spiideo — GET/POST `/api/org/[slug]/graphic-packages/import`, UI in venue page
- [x] File upload to Supabase Storage — POST `/api/org/[slug]/graphic-packages/upload`, upload buttons next to URL fields

### Phase 3: Recording Integration

- [x] When scheduling a recording, auto-attach org's default graphic package (server-side in games route)
- [x] Allow override in scheduling form (dropdown: "Use Default" / "None" / specific package)
- [x] `schedule-recording.ts` passes `graphicPackageId` into recording insert
- [x] Show which graphic package a recording uses in the recordings list (purple badge)

### Phase 4: Player Overlay Rendering

- [x] Added `GraphicPackageOverlay` interface + `graphicPackage` prop to `VideoPlayer.tsx`
- [x] Overlay prefers `graphicPackage` over legacy `mediaPack` (fallback preserved)
- [x] Integrated into watch page (`/watch/[token]`) and recordings page (`/recordings/[id]`)
- [x] Handle opacity (semi-transparent watermark style, ~0.7 opacity via `opacity-70` class)
- [x] Responsive: percentage-based positioning using Tailwind absolute positioning classes

## Files That Will Change

| File | Change |
|------|--------|
| `src/app/api/recordings/[id]/route.ts` | Fetch graphic package, fallback chain |
| `src/app/api/watch/[token]/route.ts` | Same fallback logic |
| `src/app/venue/[venueId]/page.tsx` | Scheduling form: pick graphic package |
| `src/lib/spiideo/client.ts` | Add `getGraphicPackages()` method |
| New: `src/app/api/org/[orgId]/graphic-packages/route.ts` | CRUD |
| New: `src/components/streaming/GraphicsOverlay.tsx` | CSS overlay component |
| New: migration SQL | Table + column + RLS |

## Spiideo Graphic Packages — API Reference

```
GET /v1/graphic-packages
  Query params: accountId, nameSearch, sport[], graphicPackageType (html|svg), includePublicGraphicPackages
  Response: { content: GraphicPackage[], nextParameters }

GraphicPackage:
  id: UUID (read-only)
  accountId: UUID
  name: string (required)
  sports: string[] (required, min 1)
  type: 'html' | 'svg' (required)
```

API only returns metadata — no actual graphic assets. Import creates a local record linked to the Spiideo ID, assets uploaded to Supabase separately.

## LIGR Research — Key Takeaways

- LIGR uses **predefined position slots**, not x/y coordinates — users pick a theme, theme dictates layout
- Graphics rendered as **transparent HTML overlay** over video (CSS/HTML, not baked in)
- Logo spec: **300x300 PNG transparent background**
- Watermarks use **~0.7 opacity** for semi-transparent effect
- Their real complexity is in live data (scoreboards, events) — our static logo overlay is dramatically simpler
- No public API — can't integrate with them, but don't need to
