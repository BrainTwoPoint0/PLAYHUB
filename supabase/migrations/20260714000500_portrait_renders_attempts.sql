-- Bounded automatic retries for transient render failures (Modal outage,
-- CDN hiccup): plain sweep runs retry error rows while attempts < 3; the
-- candidates view (amended alongside) stops counting a match as pending once
-- its failures are exhausted, so a permanently-broken clip cannot livelock
-- the sweep.

set local lock_timeout = '3s';

alter table public.playhub_portrait_renders
  add column if not exists attempts integer not null default 0;
