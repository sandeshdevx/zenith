import { z } from "zod";

/**
 * Shared API contracts for Zenith.
 * Every REST DTO and WebSocket event crossing a process boundary is defined
 * here, so the API, worker, PWA, and dashboard can never drift apart.
 */

// ---------------------------------------------------------------------------
// Error envelope (TRD §7: consistent error envelopes on every endpoint)
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessionStatusSchema = z.enum([
  "created",
  "active",
  "escalation_pending",
  "handoff_active",
  "ended",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionModeSchema = z.enum(["text", "voice"]);
export type SessionMode = z.infer<typeof sessionModeSchema>;

/** Risk tier is an attribute of a session, never a status. Invisible to users. */
export const riskTierSchema = z.enum(["green", "yellow", "orange", "red"]);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

// ---------------------------------------------------------------------------
// WebSocket events (TRD §7)
// ---------------------------------------------------------------------------

export const wsEventNameSchema = z.enum([
  "session.created",
  "message.received",
  "message.sent",
  "risk.updated", // internal + counsellor plane only — never sent to the user socket
  "counsellor.alerted",
  "counsellor.accepted",
  "session.ended",
]);
export type WsEventName = z.infer<typeof wsEventNameSchema>;

// ---------------------------------------------------------------------------
// Health / readiness
// ---------------------------------------------------------------------------

export const dependencyStatusSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const readyResponseSchema = z.object({
  ready: z.boolean(),
  dependencies: z.array(dependencyStatusSchema),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
