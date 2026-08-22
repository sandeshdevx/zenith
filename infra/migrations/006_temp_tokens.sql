-- Phase 6: temporary counsellor tokens (TRD §8.1).
-- Allows any email to request a magic link without pre-seeding in the counsellors table.
-- Tokens are single-use, expire in 15 minutes, and map to a temporary counsellor session.

CREATE TABLE IF NOT EXISTS counsellor_temp_tokens (
  token_hash    text PRIMARY KEY,
  email         text NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_counsellor_temp_tokens_expires
  ON counsellor_temp_tokens (expires_at);
CREATE INDEX idx_counsellor_temp_tokens_used
  ON counsellor_temp_tokens (used_at);