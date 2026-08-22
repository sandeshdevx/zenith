/**
 * Counsellor dashboard API + realtime client.
 * No authentication required — all endpoints and WS are open.
 */
import type { AlertPayload, CounsellorServerFrame } from "@zenith/contracts";

export async function setAvailability(available: boolean): Promise<void> {
  await fetch("/api/v1/counsellor/availability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ available }),
  });
}

export async function fetchQueue(): Promise<AlertPayload[]> {
  const res = await fetch("/api/v1/counsellor/queue");
  if (!res.ok) return [];
  return ((await res.json()) as { alerts: AlertPayload[] }).alerts;
}

export async function acceptSession(
  sessionId: string,
): Promise<{ roomUrl: string } | null> {
  const res = await fetch(`/api/v1/counsellor/sessions/${sessionId}/accept`, {
    method: "POST",
  });
  return res.ok ? ((await res.json()) as { roomUrl: string }) : null;
}

export async function declineSession(sessionId: string): Promise<void> {
  await fetch(`/api/v1/counsellor/sessions/${sessionId}/decline`, {
    method: "POST",
  });
}

export class CounsellorRealtime {
  private ws: WebSocket | null = null;
  private stopped = false;
  private heartbeat: number | undefined;

  constructor(private readonly onFrame: (frame: CounsellorServerFrame) => void) {}

  connect(): void {
    if (this.stopped) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/v1/counsellor/ws`);
    this.ws = ws;
    ws.onopen = () => {
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