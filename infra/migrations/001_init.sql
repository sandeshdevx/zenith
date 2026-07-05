-- Phase 1: anonymous session core (TRD §6).
-- No user profile table, ever. No PII columns, ever. IPs never touch these tables.

CREATE TABLE sessions (
  id             uuid PRIMARY KEY,
  status         text NOT NULL CHECK (status IN ('created','active','escalation_pending','handoff_active','ended')),
  mode           text NOT NULL DEFAULT 'text' CHECK (mode IN ('text','voice')),
  -- Risk tier is invisible to the user; it is never returned on user-facing endpoints.
  risk_tier      text NOT NULL DEFAULT 'green' CHECK (risk_tier IN ('green','yellow','orange','red')),
  counsellor_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);

CREATE INDEX idx_sessions_status ON sessions (status);
CREATE INDEX idx_sessions_last_active_at ON sessions (last_active_at);
CREATE INDEX idx_sessions_risk_tier ON sessions (risk_tier);

-- Short-lived conversation content. Deleted by the purge worker, never archived.
CREATE TABLE session_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  sender     text NOT NULL CHECK (sender IN ('user','buddy','counsellor')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_messages_session_id ON session_messages (session_id);
CREATE INDEX idx_session_messages_created_at ON session_messages (created_at);

-- Operational events for debugging and metrics. Payloads carry IDs and counts,
-- never conversation content. Cascade-deleted with the session by design.
CREATE TABLE session_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_events_session_id ON session_events (session_id);

-- Admin/security actions and aggregate operational records (e.g. purge counts).
CREATE TABLE system_audit_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor      text NOT NULL,
  action     text NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
