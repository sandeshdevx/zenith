-- Phase 5: counsellor plane (TRD §6, §8).
-- Counsellors are the only identity-backed accounts in the system. Nothing
-- here links to anonymous users beyond a session UUID on an alert.

CREATE TABLE counsellors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role         text NOT NULL DEFAULT 'counsellor' CHECK (role IN ('counsellor','supervisor','admin')),
  totp_secret  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counsellor_availability (
  counsellor_id uuid PRIMARY KEY REFERENCES counsellors (id) ON DELETE CASCADE,
  is_available  boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_counsellor_availability
  ON counsellor_availability (is_available, last_seen_at);

-- Magic-link tokens: only the SHA-256 hash is stored, single-use, short-lived.
CREATE TABLE login_tokens (
  token_hash    text PRIMARY KEY,
  counsellor_id uuid NOT NULL REFERENCES counsellors (id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

-- Crisis alerts (PRD Flow B). Active for 10 minutes, atomically claimable.
CREATE TABLE alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  tier          text NOT NULL CHECK (tier IN ('orange','red')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','accepted','expired')),
  counsellor_id uuid REFERENCES counsellors (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  expires_at    timestamptz NOT NULL
);

CREATE INDEX idx_alerts_status ON alerts (status, expires_at);
CREATE UNIQUE INDEX uniq_active_alert_per_session ON alerts (session_id) WHERE status = 'active';
