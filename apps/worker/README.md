# @zenith/worker (placeholder)

Background process — arrives in Phase 1 (purge job) and grows in Phase 4 (risk scoring queue).

Planned: pg-boss consumers for `purge_expired_sessions`, `score_message`, alert expiry, and handoff reconciliation. Jobs carry IDs only, never message content.
