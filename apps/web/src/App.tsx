import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMessage, WsServerFrame } from "@zenith/contracts";
import {
  acceptHandoff,
  createSession,
  declineHandoff,
  endSession,
  escalate,
  fetchSupportOptions,
  RealtimeClient,
  type SupportOption,
} from "./session.js";

type Phase = "landing" | "chat" | "ended";
type Status = "connecting" | "online" | "reconnecting" | "closed";

interface ChatMessage {
  key: string;
  sender: "user" | "buddy" | "counsellor";
  content: string;
}

let keyCounter = 0;
const nextKey = () => `m${++keyCounter}`;

export default function App() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("landing");
  const [status, setStatus] = useState<Status>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState(""); // buddy reply streaming in
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportOptions, setSupportOptions] = useState<SupportOption[]>([]);
  const [handoffOffer, setHandoffOffer] = useState<string | null>(null);
  const [videoRoom, setVideoRoom] = useState<string | null>(null);
  const [waitingForHuman, setWaitingForHuman] = useState(false);
  const clientRef = useRef<RealtimeClient | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const onFrame = useCallback((frame: WsServerFrame) => {
    if (frame.type === "message.delta") {
      setThinking(false);
      setDraft((d) => d + frame.content);
    } else if (frame.type === "message.sent") {
      setThinking(false);
      setDraft("");
      setMessages((m) => [
        ...m,
        { key: nextKey(), sender: frame.sender, content: frame.content },
      ]);
    } else if (frame.type === "handoff.offer") {
      setHandoffOffer(frame.roomUrl);
      setWaitingForHuman(false);
    } else if (frame.type === "session.ended") {
      setPhase("ended");
    }
  }, []);

  const onResync = useCallback((history: SessionMessage[]) => {
    setMessages(
      history.map((m) => ({ key: `db-${m.messageId}`, sender: m.sender, content: m.content })),
    );
  }, []);

  const begin = useCallback(async () => {
    setPhase("chat");
    await createSession();
    const client = new RealtimeClient({ onFrame, onStatus: setStatus, onResync });
    clientRef.current = client;
    client.connect();
    void fetchSupportOptions().then(setSupportOptions);
  }, [onFrame, onResync]);

  const send = useCallback(() => {
    const content = input.trim();
    if (!content) return;
    setMessages((m) => [...m, { key: nextKey(), sender: "user", content }]);
    setInput("");
    setThinking(true);
    clientRef.current?.sendMessage(content);
  }, [input]);

  const leave = useCallback(async () => {
    clientRef.current?.stop();
    await endSession();
    setMessages([]);
    setDraft("");
    setPhase("ended");
  }, []);

  // keep the newest words in view
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft, thinking]);

  if (phase === "landing") {
    return (
      <div className="shell">
        <main className="landing">
          <h1>{t("landing.title")}</h1>
          <p className="sub">{t("landing.subtitle")}</p>
          <button className="begin" onClick={() => void begin()}>
            {t("landing.start")}
          </button>
          <p className="reassure">{t("landing.reassurance")}</p>
        </main>
        <HumanDoor
          onOpen={() => {
            void fetchSupportOptions().then(setSupportOptions);
            setSupportOpen(true);
          }}
        />
        {supportOpen && (
          <SupportPanel options={supportOptions} onClose={() => setSupportOpen(false)} />
        )}
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="shell">
        <div className="ended">
          <p>{t("chat.endedNote")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="chat">
        <div className="chat-head">
          <span className="status">
            <span className="breath" aria-hidden />
            {status === "online" ? "zenith" : t(status === "connecting" ? "chat.connecting" : "chat.reconnecting")}
          </span>
          <button className="leave" onClick={() => void leave()}>
            {t("chat.endSession")}
          </button>
        </div>

        <div className="stream" ref={streamRef}>
          {messages.map((m) =>
            m.sender === "user" ? (
              <div key={m.key} className="msg-user">
                {m.content}
              </div>
            ) : (
              <div key={m.key} className="msg-buddy">
                {m.content}
              </div>
            ),
          )}
          {draft && <div className="msg-buddy">{draft}</div>}
          {thinking && !draft && (
            <span className="thinking">
              <span className="breath" aria-hidden />
              {t("chat.listening")}
            </span>
          )}
          {waitingForHuman && !handoffOffer && (
            <span className="thinking">
              <span className="breath" aria-hidden />
              {t("handoff.finding")}
            </span>
          )}
          {handoffOffer && (
            <div className="handoff-offer">
              <button
                className="handoff-yes"
                onClick={() => {
                  void acceptHandoff().then((room) => {
                    if (room) setVideoRoom(room);
                    setHandoffOffer(null);
                  });
                }}
              >
                {t("handoff.accept")}
              </button>
              <button
                className="handoff-no"
                onClick={() => {
                  setHandoffOffer(null);
                  void declineHandoff();
                }}
              >
                {t("handoff.decline")}
              </button>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            rows={1}
            value={input}
            placeholder={t("chat.placeholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send" disabled={!input.trim()} onClick={send}>
            {t("chat.send")}
          </button>
        </div>

        <HumanDoor
          onOpen={() => {
            setSupportOpen(true);
          }}
        />
      </div>
      {supportOpen && (
        <SupportPanel
          options={supportOptions}
          onClose={() => setSupportOpen(false)}
          onVolunteer={() => {
            setSupportOpen(false);
            setWaitingForHuman(true);
            void escalate();
          }}
        />
      )}
      {videoRoom && (
        <div className="video-veil">
          <div className="video-bar">
            <button onClick={() => setVideoRoom(null)}>{t("handoff.backToChat")}</button>
          </div>
          <iframe
            src={videoRoom}
            allow="camera; microphone; fullscreen; display-capture"
            title="zenith-call"
          />
        </div>
      )}
    </div>
  );
}

/** Always-visible path to a human — the PRD's manual escape hatch. */
function HumanDoor({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="human-door">
      <button onClick={onOpen}>{t("support.talkToPerson")}</button>
    </div>
  );
}

function SupportPanel({
  options,
  onClose,
  onVolunteer,
}: {
  options: SupportOption[];
  onClose: () => void;
  onVolunteer?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="support-veil" onClick={onClose}>
      <div className="support-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("support.panelTitle")}</h2>
        <p className="note">{t("support.panelNote")}</p>
        {options
          .filter((o) => o.available)
          .map((o) => (
            <div key={o.id} className="support-option">
              <div className="meta">
                <div className="label">{t(o.labelKey)}</div>
                {o.hours && (
                  <div className="hours">
                    {t("support.hours")}: {o.hours}
                  </div>
                )}
              </div>
              {o.kind === "phone" && o.phone && (
                <a href={`tel:${o.phone}`}>{t("support.call")}</a>
              )}
              {o.kind === "link" && o.url && (
                <a href={o.url} target="_blank" rel="noreferrer">
                  {t("support.open")}
                </a>
              )}
              {o.kind === "video" && onVolunteer && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onVolunteer();
                  }}
                >
                  {t("support.connect")}
                </a>
              )}
            </div>
          ))}
        <button className="support-close" onClick={onClose}>
          {t("support.close")}
        </button>
      </div>
    </div>
  );
}
