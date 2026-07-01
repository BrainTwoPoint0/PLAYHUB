-- TikTok connections — Login Kit OAuth + Content Posting
-- One row per PLAYHUB user who has connected their TikTok account.
-- Mirrors the playerdata_connections model: tokens are written and read ONLY via
-- the service-role client. RLS is enabled with NO authenticated policies, so the
-- access/refresh tokens are never reachable from the browser. All TikTok reads
-- (profile, stats, video list) and the publish flow go through server API routes.
--
-- TikTok token lifetimes: access_token ~24h, refresh_token ~365d. The refresh
-- token ROTATES on every refresh, so client.ts stores both new tokens atomically
-- (identical single-use discipline to PlayerData) and flips is_active=false when a
-- refresh fails so the UI can prompt a reconnect.

CREATE TABLE IF NOT EXISTS tiktok_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One active connection per user (upsert conflict target).
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  -- TikTok's per-app-scoped user id (stable identifier for this app), plus the
  -- cross-app union_id when the account has granted it.
  open_id TEXT NOT NULL,
  union_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  -- Comma-separated granted scopes, as returned by the token endpoint. The client
  -- always writes a string (never null), so NOT NULL DEFAULT '' matches the code.
  scope TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No extra index on user_id: the UNIQUE constraint above already creates a unique
-- btree index that serves every `WHERE user_id = $1` lookup and backs the upsert
-- onConflict. Same TikTok account (open_id) may link to more than one PLAYHUB user
-- by design (e.g. a shared club account), so open_id is intentionally NOT unique.

-- RLS on, deny-all to authenticated: tokens are secrets. service_role bypasses RLS
-- and is the only path that reads/writes this table (see src/lib/tiktok/client.ts).
-- REVOKE + FORCE make RLS a second barrier rather than the sole one, so a future
-- stray policy or table-owner query can't leak the token vault via PostgREST.
ALTER TABLE tiktok_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_connections FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE tiktok_connections FROM anon, authenticated;
GRANT ALL ON TABLE tiktok_connections TO service_role;

-- Reuse the shared updated_at trigger defined by the portrait-crop migration.
CREATE OR REPLACE TRIGGER trg_tiktok_connections_updated_at
  BEFORE UPDATE ON tiktok_connections
  FOR EACH ROW EXECUTE FUNCTION playhub_touch_updated_at();
