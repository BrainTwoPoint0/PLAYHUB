# Organization Dashboard — Roadmap

**Status:** Partially Complete (graphics packages + marketplace settings done, recordings view + team management pending)

## Context

PLAYHUB is currently venue-centric. Organizations (DAFL, Sevens, Li3ib, PLAYBACK) exist in the DB (`organizations`, `organization_members`) but don't have their own dashboard or space in the UI.

An org like DAFL is a league that books recordings across multiple venues. They need their own space to manage everything that belongs to them — separate from the venue management view.

## Two-Layer Model

1. **Venue** = physical location with cameras (Jaber Stadium, etc.)
   - Handles billing, camera access, scheduling, Spiideo scenes
   - Owned by the venue operator

2. **Organization** = the league/club/entity (DAFL, Sevens, Li3ib)
   - Owns recordings (across all venues they book at)
   - Owns branding/graphics packages
   - Manages team/employee access
   - Sells recordings through the PLAYHUB marketplace

## Planned Features

### Graphics Packages (→ see [graphic-packages.md](graphic-packages.md))
- [x] Account-level graphics (logos, sponsors, overlays)
- [x] Import from Spiideo or create custom
- [x] Applied when org starts a recording at any venue
- [x] File upload to Supabase Storage

### Recordings View
- [ ] All recordings across all venues, filtered by org
- [ ] Search, filter by date/venue/status
- [ ] Bulk actions (publish, set pricing, etc.)

### Team & Access Management
- [ ] Invite employees by email
- [ ] Role-based access (admin, manager, viewer)
- [ ] Uses existing `organization_members` table

### Marketplace / Storefront
- [x] Marketplace settings moved from venue to org level (`organizations` table)
- [x] Enable/disable marketplace per org + default pricing/currency
- [x] API: `GET/PUT /api/org/[slug]/marketplace`
- [x] UI: MarketplaceSettingsSection component
- [ ] Revenue dashboard (sales, views, downloads)
- [ ] Stripe Connect for payouts (future)

### Live View Preview
- [ ] Show Spiideo camera live feed before recording starts
- [ ] Overlay org's graphics package on the preview
- [ ] **Blocker:** Spiideo public API does NOT expose a live view endpoint
- [ ] Options: ask Spiideo for private API, Playwright scrape, or use our MediaLive pipeline for a brief preview production

## Spiideo Live View — Research Notes

The "Live View" shown in Spiideo's web dashboard (`app.spiideo.net`) is a feature of their UI, not exposed via the public API (`docs-public.spiideo.com`). The API covers:
- Game scheduling, productions, outputs, downloads, shareable links
- But NO camera preview/live feed endpoints

Possible approaches:
1. **Ask Spiideo** if there's a private/beta endpoint for scene live view
2. **Playwright scrape** the dashboard (fragile, like Veo auth)
3. **Use our own pipeline** — start a brief push_stream production → MediaLive → HLS preview, then tear it down
