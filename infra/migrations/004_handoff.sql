-- Phase 6: human handoff. The room name is a UUID — the Jitsi room is
-- anonymous, created per escalation, and dies with the session.
ALTER TABLE sessions ADD COLUMN handoff_room text;
