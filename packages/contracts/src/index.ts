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

export const messageSenderSchema = z.enum(["user", "buddy", "counsellor"]);
export type MessageSender = z.infer<typeof messageSenderSchema>;

/** Client → server frames on the anonymous user socket. */
export const wsClientFrameSchema = z.discriminatedUnion("type", [
  // Browsers cannot set headers on a WebSocket upgrade, so the first frame
  // authenticates the connection (5s deadline server-side).
  z.object({ type: z.literal("auth"), token: z.string() }),
  z.object({ type: z.literal("message"), content: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

/** Server → client frames on the anonymous user socket. Never carries risk data. */
export const wsServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.ok"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("auth.error"), reason: z.string() }),
  // Ack that the user's message was persisted.
  z.object({
    type: z.literal("message.received"),
    messageId: z.string(),
    createdAt: z.string(),
  }),
  // A complete message addressed to the user (buddy or counsellor).
  z.object({
    type: z.literal("message.sent"),
    messageId: z.string(),
    sender: messageSenderSchema,
    content: z.string(),
    createdAt: z.string(),
  }),
  // Streaming fragment of an in-progress buddy reply.
  z.object({ type: z.literal("message.delta"), content: z.string() }),
  z.object({ type: z.literal("session.ended") }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

export const sessionMessageSchema = z.object({
  messageId: z.string(),
  sender: messageSenderSchema,
  content: z.string(),
  createdAt: z.string(),
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

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
