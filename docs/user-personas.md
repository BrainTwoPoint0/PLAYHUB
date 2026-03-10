# PLAYHUB User & Organization Personas

## Organization Types

### Group (`type: 'group'`)

**Examples:** Li3ib, Powerleague

A parent company that owns/operates one or more venues. They sign the contract with PLAYBACK for camera installation and services.

**Characteristics:**

- Doesn't have cameras directly — their child venues do
- Needs aggregate visibility across all child venues
- Revenue from child venues rolls up to the group
- Admins automatically have access to all child venues
- Sets targets for individual venues
- May have its own graphic packages used across venues

**Dashboard needs:** Birds-eye view, aggregate revenue, per-venue performance, cross-venue recording management

---

### Venue (`type: 'venue'`)

**Examples:** Nazwa Fields, Powerleague Shoreditch, The Sevens, Jebel Ali

A physical location with cameras installed. Can be owned by a group or independent.

**Characteristics:**

- Has physical camera infrastructure (Spiideo scenes)
- Recordings happen here
- Has its own billing config and invoice history
- Can be a child of a group (Nazwa → Li3ib) or standalone
- Multiple external orgs (tenants) can record here
- Venue admins manage day-to-day operations: scheduling recordings, managing access, billing

**Dashboard needs:** Recording list, schedule recording, billing summary, admin management

---

### League (`type: 'league'`)

**Examples:** DAFL (Dubai Amateur Football League)

An organization that runs competitions across multiple venues they don't own.

**Characteristics:**

- Does NOT own venues — uses them as a tenant
- Needs `organization_venue_access` to record at external venues
- Recordings belong to the league, not the venue
- Has its own graphic packages (sponsor logos, branding)
- Venue management cannot see league recordings unless explicitly granted access
- May run games at multiple venues in a single week

**Revenue model:** Records for free (no per-recording cost) → monetizes through marketplace sales to players/parents + sponsorship deals (graphic packages with sponsor logos). PLAYHUB takes a % of marketplace revenue.

**Dashboard needs:** Their recordings (across all venues), graphic packages, marketplace sales/revenue, access management

---

### Academy (`type: 'academy'`)

**Examples:** CFA, SEFA

A training academy focused on player development.

**Characteristics:**

- Primary use case today: **Veo automations** (Veo has no API, so PLAYHUB handles the automation layer)
- Future focus: player profiles, player media/highlights, performance tracking
- May use external venues (like a league) for training and matches
- Could sell recordings to parents through the marketplace (future)
- Less focused on live streaming, more on capture and distribution

**Current dashboard needs:** Veo automation config, recording management
**Future dashboard needs:** Player profiles, media library, parent access portal, team management

---

## User Roles

### Platform Admin (`is_platform_admin: true`)

**Example:** PLAYBACK staff (us)

- Full access to admin dashboard at `/admin`
- Can toggle feature flags for any organization
- Can create/delete users, manage all venues
- Can set parent-child org relationships
- Can create tenant access between orgs and venues

### Group Admin (`club_admin` at a group org)

**Example:** Li3ib management

- Automatic admin access to ALL child venues
- Sees aggregate dashboard across child venues
- Can set targets for individual venues
- Can manage graphic packages at group level
- Can manage admins for the group (and implicitly child venues)

### Venue Admin (`club_admin` at a venue org)

**Example:** Nazwa venue management team (li3ib user)

- Manages a single venue's operations
- Schedules recordings, manages access
- Views billing and invoice history
- Manages venue-level admins
- Can only see recordings owned by their venue
- Cannot see recordings made by tenant orgs at their venue

### League Admin (`league_admin` at a league org)

**Example:** DAFL operations team

- Manages league recordings across all authorized venues
- Schedules recordings at venues where `organization_venue_access` exists
- Manages league graphic packages
- Can grant recording access to venue admins or anyone else
- Sees only their league's recordings, not the venue's

### Regular User (no admin role)

**Example:** A player, parent, or fan

- Browses the marketplace
- Purchases recordings
- Views purchased recordings in "My Recordings"
- May receive access grants from venue/league admins

---

## Relationship Examples

### Li3ib + Nazwa

```
Li3ib (group)
  └── Nazwa (venue)     [parent_organization_id = Li3ib.id]

- Li3ib admin → automatically Nazwa admin
- Nazwa admin → can manage Nazwa, cannot access Li3ib dashboard
- Nazwa recordings → visible to both Nazwa and Li3ib admins
- Revenue → rolls up to Li3ib aggregate view
```

### DAFL + The Sevens

```
DAFL (league) ──tenant──→ The Sevens (venue)
                           [organization_venue_access row]

- DAFL admin → can schedule recordings at The Sevens
- DAFL recordings at The Sevens → owned by DAFL, not The Sevens
- The Sevens admin → cannot see DAFL recordings
- DAFL can grant access to specific The Sevens users if desired
- DAFL's graphic package → auto-applied to recordings at The Sevens
```

### Powerleague (future)

```
Powerleague (group)
  ├── PL Shoreditch (venue)
  ├── PL Wandsworth (venue)
  └── PL Brixton (venue)

- Powerleague admin → access to all 3 venues
- Each venue has its own local admins
- Powerleague dashboard → aggregate revenue, per-venue breakdown
- Individual venue admins → only their venue
```

---

## Access Matrix

| Action                      | Platform Admin | Group Admin        | Venue Admin              | League Admin             | Regular User |
| --------------------------- | -------------- | ------------------ | ------------------------ | ------------------------ | ------------ |
| Admin dashboard             | Yes            | No                 | No                       | No                       | No           |
| Toggle org features         | Yes            | No                 | No                       | No                       | No           |
| View child venue data       | N/A            | Yes (all children) | No                       | No                       | No           |
| Schedule recording at venue | Yes            | Yes (child venues) | Yes (own venue)          | Yes (tenant venues)      | No           |
| View venue recordings       | Yes            | Yes (child venues) | Yes (own venue only)     | No                       | No           |
| View own org recordings     | Yes            | Yes                | Yes                      | Yes                      | No           |
| Grant recording access      | Yes            | Yes                | Yes (own recordings)     | Yes (own recordings)     | No           |
| Manage graphic packages     | Yes            | Yes                | Yes (if feature enabled) | Yes (if feature enabled) | No           |
| Browse marketplace          | Yes            | Yes                | Yes                      | Yes                      | Yes          |
| Purchase recordings         | Yes            | Yes                | Yes                      | Yes                      | Yes          |
| View purchased recordings   | Yes            | Yes                | Yes                      | Yes                      | Yes          |
