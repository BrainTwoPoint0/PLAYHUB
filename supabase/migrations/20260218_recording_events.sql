-- Video Event Tagging System
-- Allows users to tag events (goals, saves, etc.) on match recording timelines

CREATE TABLE playhub_recording_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_recording_id UUID NOT NULL REFERENCES playhub_match_recordings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp_seconds NUMERIC(10,2) NOT NULL,
  team TEXT,
  label TEXT,
  visibility TEXT DEFAULT 'public' NOT NULL,
  source TEXT DEFAULT 'manual' NOT NULL,
  confidence_score NUMERIC(3,2),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_event_type CHECK (event_type IN (
    'goal', 'shot', 'save', 'corner', 'free_kick',
    'yellow_card', 'red_card', 'penalty', 'kick_off',
    'half_time', 'full_time', 'foul', 'substitution', 'other'
  )),
  CONSTRAINT valid_visibility CHECK (visibility IN ('public', 'private')),
  CONSTRAINT valid_source CHECK (source IN ('manual', 'ai_detected')),
  CONSTRAINT valid_confidence CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  CONSTRAINT valid_timestamp CHECK (timestamp_seconds >= 0),
  CONSTRAINT valid_team CHECK (team IS NULL OR team IN ('home', 'away'))
);

-- Indexes
CREATE INDEX idx_recording_events_match ON playhub_recording_events(match_recording_id);
CREATE INDEX idx_recording_events_timestamp ON playhub_recording_events(match_recording_id, timestamp_seconds);

-- RLS
ALTER TABLE playhub_recording_events ENABLE ROW LEVEL SECURITY;

-- SELECT: public events + own private events
CREATE POLICY "Users can view public events and own private events"
  ON playhub_recording_events FOR SELECT TO authenticated
  USING (visibility = 'public' OR created_by = auth.uid());

-- INSERT: any authenticated user
CREATE POLICY "Authenticated users can create events"
  ON playhub_recording_events FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- UPDATE: own events only
CREATE POLICY "Users can update own events"
  ON playhub_recording_events FOR UPDATE TO authenticated
  USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

-- DELETE: own events only
CREATE POLICY "Users can delete own events"
  ON playhub_recording_events FOR DELETE TO authenticated
  USING (created_by = auth.uid());

-- Grants
GRANT ALL ON TABLE playhub_recording_events TO authenticated;
GRANT ALL ON TABLE playhub_recording_events TO service_role;
