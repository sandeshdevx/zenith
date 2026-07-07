/**
 * Anonymous session + realtime client.
 * The token lives in module memory only — closing the tab is leaving.
 * Nothing about the conversation ever touches localStorage/IndexedDB.
 */
import type { ProsodyFeaturesDto, SessionMessage, WsServerFrame } from "@zenith/contracts";

export interface SupportOption {
  id: string;
  kind: "video" | "phone" | "link";
  labelKey: string;
  phone?: string;
  url?: string;
  hours?: string;
  available: boolean;
}

export interface RealtimeCallbacks {
  onFrame: (frame: WsServerFrame) => void;
  onStatus: (status: "connecting" | "online" | "reconnecting" | "closed") => void;
  /** Called after a reconnect so the UI can reconcile from the DB. */
  onResync: (messages: SessionMessage[]) => void;
}

let token: string | null = null;
let sessionId: string | null = null;

export async function createSession(): Promise<string> {
  const res = await fetch("/api/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error("could not create session");
  const body = (await res.json()) as { sessionId: string; token: string };
  token = body.token;
  sessionId = body.sessionId;
  return body.sessionId;
}

export async function fetchMessages(): Promise<SessionMessage[]> {
  if (!token || !sessionId) return [];
  const res = await fetch(`/api/v1/sessions/${sessionId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { messages: SessionMessage[] };
  return body.messages;
}

export async function fetchSupportOptions(): Promise<SupportOption[]> {
  const res = await fetch("/api/v1/support-options");
  if (!res.ok) return [];
  const body = (await res.json()) as { options: SupportOption[] };
  return body.options;
}

/** Server-side Whisper transcription (works in every browser). */
export async function transcribe(
  audio: Blob,
  lang?: string,
): Promise<{ text: string; language: string } | null> {
  if (!token) return null;
  const query = lang && lang !== "auto" ? `?lang=${encodeURIComponent(lang)}` : "";
  const res = await fetch(`/api/v1/stt${query}`, {
    method: "POST",
    headers: {
      "content-type": audio.type || "application/octet-stream",
      authorization: `Bearer ${token}`,
    },
    body: audio,
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as { text: string; language: string };
}

/** Neural TTS for buddy replies; null → caller falls back to local voices. */
export async function synthesize(text: string, lang: string): Promise<Blob | null> {
  if (!token) return null;
  const res = await fetch("/api/v1/tts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, lang }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const blob = await res.blob();
  return blob.size > 0 ? blob : null;
}

/** Ask for a human directly (manual escape hatch). */
export async function escalate(): Promise<void> {
  if (!token || !sessionId) return;
  await fetch(`/api/v1/sessions/${sessionId}/escalate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function acceptHandoff(): Promise<string | null> {
  if (!token || !sessionId) return null;
  const res = await fetch(`/api/v1/sessions/${sessionId}/handoff/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return ((await res.json()) as { roomUrl: string }).roomUrl;
}

export async function declineHandoff(): Promise<void> {
  if (!token || !sessionId) return;
  await fetch(`/api/v1/sessions/${sessionId}/handoff/decline`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function endSession(): Promise<void> {
  if (!token || !sessionId) return;
  await fetch(`/api/v1/sessions/${sessionId}/end`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
  token = null;
  sessionId = null;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private everConnected = false;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  connect(): void {
    if (this.stopped || !token) return;
    this.callbacks.onStatus(this.everConnected ? "reconnecting" : "connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/v1/ws`);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as WsServerFrame;
      if (frame.type === "auth.ok") {
        this.attempts = 0;
        this.callbacks.onStatus("online");
        if (this.everConnected) {
          // Recover anything missed while the socket was down.
          void fetchMessages().then(this.callbacks.onResync);
        }
        this.everConnected = true;
        return;
      }
      this.callbacks.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.attempts += 1;
      if (this.attempts > 6) {
        this.callbacks.onStatus("closed");
        return;
      }
      const delay = Math.min(500 * 2 ** this.attempts, 8000);
      this.callbacks.onStatus("reconnecting");
      setTimeout(() => this.connect(), delay);
    };
  }

  sendMessage(content: string, prosody?: ProsodyFeaturesDto): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "message", content, prosody }));
      return true;
    }
    // REST fallback keeps the conversation alive even without a socket.
    if (token && sessionId) {
      void fetch(`/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ content, prosody }),
      });
      return true;
    }
    return false;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
