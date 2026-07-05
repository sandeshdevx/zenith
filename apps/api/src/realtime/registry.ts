/**
 * In-process registry of live user sockets per session.
 * Single-instance by design for V1; swap the internals for Redis pub/sub if
 * WebSocket fan-out ever becomes a bottleneck (TRD §10) — callers only see
 * broadcast().
 */
import type { WebSocket } from "ws";
import type { WsServerFrame } from "@zenith/contracts";

const sockets = new Map<string, Set<WebSocket>>();

export function register(sessionId: string, socket: WebSocket): void {
  let set = sockets.get(sessionId);
  if (!set) {
    set = new Set();
    sockets.set(sessionId, set);
  }
  set.add(socket);
}

export function unregister(sessionId: string, socket: WebSocket): void {
  const set = sockets.get(sessionId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sockets.delete(sessionId);
}

export function broadcast(sessionId: string, frame: WsServerFrame): void {
  const set = sockets.get(sessionId);
  if (!set) return;
  const data = JSON.stringify(frame);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

export function connectionCount(sessionId: string): number {
  return sockets.get(sessionId)?.size ?? 0;
}
