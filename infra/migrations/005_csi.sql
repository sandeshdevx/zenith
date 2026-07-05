-- CSI multi-signal engine (patent modules 102–106).
-- Prosody features are numeric acoustic measurements only (no audio, no
-- content); screening rows accumulate implicit PHQ-9/GAD-7 item matches.
-- Everything cascades with the session — the purge guarantee is unchanged.

ALTER TABLE session_messages ADD COLUMN prosody jsonb;

ALTER TABLE risk_assessments ADD COLUMN s1 real;
ALTER TABLE risk_assessments ADD COLUMN s2 real;
ALTER TABLE risk_assessments ADD COLUMN s3 real;
ALTER TABLE risk_assessments ADD COLUMN csi real;

-- Item Score Accumulator (patent 203): best similarity-scaled score per
-- clinical item per session. Item ids like 'phq9-2', 'gad7-5'.
CREATE TABLE risk_screening (
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  item_id    text NOT NULL,
  score      real NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, item_id)
);
