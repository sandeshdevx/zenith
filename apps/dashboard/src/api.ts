/**
 * Counsellor dashboard API + realtime client.
 * The counsellor token lives in memory (and the httpOnly cookie set by the
 * server); the WS authenticates with the in-memory copy.
 */
import type { AlertPayload, CounsellorServerFrame } from "@zenith/contracts";

let token: string | null = null;

export function hasToken(): boolean {
  return token !== null;
}

export async function requestLink(email: string): Promise<void> {
  await fetch("/api/v1/counsellor/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function verifyLink(
  linkToken: string,
  totpCode?: string,
): Promise<{ ok: boolean; totpRequired: boolean }> {
  const res = await fetch("/api/v1/counsellor/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: linkToken, totpCode: totpCode || undefined }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    token = (body as { token: string }).token;
    return { ok: true, totpRequired: false };
  }
  return { ok: false, totpRequired: !!(body as { totpRequired?: boolean }).totpRequired };
}

export async function setAvailability(available: boolean): Promise<void> {
  await fetch("/api/v1/counsellor/availability", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ available }),
  });
}

export async function fetchQueue(): Promise<AlertPayload[]> {
  const res = await fetch("/api/v1/counsellor/queue", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return ((await res.json()) as { alerts: AlertPayload[] }).alerts;
}

export async function acceptSession(
  sessionId: string,
): Promise<{ roomUrl: string } | null> {
  const res = await fetch(`/api/v1/counsellor/sessions/${sessionId}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok ? ((await res.json()) as { roomUrl: string }) : null;
}

export async function declineSession(sessionId: string): Promise<void> {
  await fetch(`/api/v1/counsellor/sessions/${sessionId}/decline`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

export class CounsellorRealtime {
  private ws: WebSocket | null = null;
  private stopped = false;
  private heartbeat: number | undefined;

  constructor(private readonly onFrame: (frame: CounsellorServerFrame) => void) {}

  connect(): void {
    if (this.stopped || !token) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/v1/counsellor/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
      this.heartbeat = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 30_000);
    };
    ws.onmessage = (event) => {
      this.onFrame(JSON.parse(event.data as string) as CounsellorServerFrame);
    };
    ws.onclose = () => {
      window.clearInterval(this.heartbeat);
      if (!this.stopped) setTimeout(() => this.connect(), 3000);
    };
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
