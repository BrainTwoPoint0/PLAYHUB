-- Tombstone table so the sync Lambda doesn't re-create rows for Spiideo games
-- a user has deliberately deleted. Without this, Spiideo's DELETE /v1/games/{id}
-- "unschedules" the game but leaves it visible to /v1/games, and the Lambda's
-- orphan branch re-inserts the row as status='failed' on the next 15-min sync.

CREATE TABLE IF NOT EXISTS public.playhub_deleted_spiideo_games (
  spiideo_game_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.playhub_deleted_spiideo_games IS
  'Persistent tombstone for Spiideo game IDs the user has deleted via PLAYHUB. Read by sync Lambda to skip orphan re-creation.';

ALTER TABLE public.playhub_deleted_spiideo_games ENABLE ROW LEVEL SECURITY;

-- No policies: service-role only. The DELETE recording API and the sync Lambda
-- both use the service client; user-facing reads of this table are never needed.
