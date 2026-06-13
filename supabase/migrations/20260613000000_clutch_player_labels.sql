-- Clutch per-match player labels: maps Clutch's internal track IDs
-- (player-N) to human names so per-player stats can show real people.
-- display_name is free text in v1 (no PLAYBACK profile linking).
-- RLS enabled with NO policies = deny-all; reads/writes happen only via
-- service-role from /api/recordings/[id]/clutch, which enforces
-- checkRecordingAccess per request.

CREATE TABLE public.playhub_clutch_player_labels (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  match_recording_id uuid NOT NULL
    REFERENCES public.playhub_match_recordings(id) ON DELETE CASCADE,
  provider_player_id text NOT NULL
    CHECK (provider_player_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 60),
  labeled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_recording_id, provider_player_id)
);

ALTER TABLE public.playhub_clutch_player_labels ENABLE ROW LEVEL SECURITY;

-- The UNIQUE constraint already indexes match_recording_id as its leading
-- column, which serves the per-recording label fetch.
