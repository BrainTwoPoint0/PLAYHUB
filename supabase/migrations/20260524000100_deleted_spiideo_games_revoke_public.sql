-- Defense in depth: tombstone table is service-role only by design.
-- Explicitly revoke the default PUBLIC grant so a future migration that adds
-- a permissive policy elsewhere can't accidentally widen this surface.

REVOKE ALL ON public.playhub_deleted_spiideo_games FROM PUBLIC;
REVOKE ALL ON public.playhub_deleted_spiideo_games FROM anon, authenticated;
