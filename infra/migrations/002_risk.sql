-- Phase 4: risk scoring history (TRD §6: risk_assessments).
-- signals hold pattern IDs only — never message content — so nothing
-- conversational leaks into a scoring table. Cascade-deleted with the session.

CREATE TABLE risk_assessments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  message_id bigint REFERENCES session_messages (id) ON DELETE CASCADE,
  tier       text NOT NULL CHECK (tier IN ('green','yellow','orange','red')),
  score      real,
  source     text NOT NULL,
  signals    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_risk_assessments_session_id ON risk_assessments (session_id, id DESC);
