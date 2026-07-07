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
  transcribe,
  RealtimeClient,
  type SupportOption,
} from "./session.js";
import { listen, speak, stopSpeaking, voiceInputSupported, type ListenSession } from "./voice.js";
import { startProsodyCapture, type ProsodyCapture } from "./prosody.js";
import { recorderSupported, recordUtterance, type UtteranceHandle } from "./recorder.js";

type Phase = "landing" | "chat" | "ended";
type Status = "connecting" | "online" | "reconnecting" | "closed";
type VoicePhase = "listening" | "thinking" | "speaking";

interface ChatMessage {
  key: string;
  sender: "user" | "buddy" | "counsellor";
  content: string;
}

let keyCounter = 0;
const nextKey = () => `m${++keyCounter}`;

export default function App() {
  const { t, i18n } = useTranslation();
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
  // Voice: WebSpeech where available, MediaRecorder + server Whisper
  // everywhere else — the mic works in every browser with a microphone.
  const [voiceAvailable, setVoiceAvailable] = useState(
    () => voiceInputSupported() || recorderSupported(),
  );
  const [voiceUnsupported] = useState(() => !voiceInputSupported() && !recorderSupported());
  const [voiceLang, setVoiceLang] = useState("auto");
  const [connectFailed, setConnectFailed] = useState(false);
  const [listening, setListening] = useState(false);
  const voiceRepliesRef = useRef(false);
  const listenRef = useRef<ListenSession | null>(null);
  const prosodyRef = useRef<ProsodyCapture | null>(null);
  // Hands-free conversation mode (speak ↔ listen loop, any browser).
  const [voiceMode, setVoiceMode] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("listening");
  const voiceModeRef = useRef(false);
  const voiceLangRef = useRef("auto");
  const spokenLangRef = useRef<string>(navigator.language);
  const utteranceRef = useRef<UtteranceHandle | null>(null);
  const listenLoopRef = useRef<() => void>(() => {});
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
      // Voice replies mirror the user's chosen mode (PRD: voice or text).
      if (frame.sender !== "user" && voiceModeRef.current) {
        // Hands-free loop: speak the reply, then listen again.
        setVoicePhase("speaking");
        speak(frame.content, spokenLangRef.current, () => {
          if (voiceModeRef.current) listenLoopRef.current();
        });
      } else if (frame.sender !== "user" && voiceRepliesRef.current) {
        speak(frame.content, navigator.language);
      }
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
    setConnectFailed(false);
    // The backend must never silently fail for someone reaching out:
    // retry, then degrade to an explicit offline card with real helplines.
    let connected = false;
    for (let attempt = 0; attempt < 3 && !connected; attempt++) {
      try {
        await createSession();
        connected = true;
      } catch {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    if (!connected) {
      setConnectFailed(true);
      setStatus("closed");
      return;
    }
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

  const sendVoice = useCallback((content: string) => {
    setMessages((m) => [...m, { key: nextKey(), sender: "user", content }]);
    setInput("");
    setThinking(true);
    // Prosody features (patent 301–302) extracted on-device travel with the
    // spoken turn; raw audio never leaves the browser.
    const prosody = prosodyRef.current?.stop() ?? undefined;
    prosodyRef.current = null;
    clientRef.current?.sendMessage(content, prosody ?? undefined);
  }, []);

  // One turn of the hands-free loop: record → Whisper → send. The reply
  // handler (message.sent) speaks the answer and calls this again.
  const listenLoop = useCallback(() => {
    if (!voiceModeRef.current) return;
    setVoicePhase("listening");
    void (async () => {
      const startedAt = Date.now();
      const prosodyPromise = startProsodyCapture();
      const blob = await recordUtterance({
        onHandle: (h) => (utteranceRef.current = h),
      });
      const prosodyCapture = await prosodyPromise;
      if (!voiceModeRef.current) {
        prosodyCapture?.stop();
        return;
      }
      if (!blob) {
        prosodyCapture?.stop();
        // Instant null = mic denied/unavailable → exit instead of spinning.
        if (Date.now() - startedAt < 1000) {
          voiceModeRef.current = false;
          setVoiceMode(false);
          return;
        }
        listenLoopRef.current(); // heard nothing — keep listening
        return;
      }
      setVoicePhase("thinking");
      const result = await transcribe(blob, voiceLangRef.current);
      if (!voiceModeRef.current) {
        prosodyCapture?.stop();
        return;
      }
      if (result?.text) {
        if (result.language) spokenLangRef.current = result.language;
        prosodyRef.current = prosodyCapture;
        sendVoice(result.text);
        // reply arrives via message.sent → speak → loop continues
      } else {
        prosodyCapture?.stop();
        listenLoopRef.current();
      }
    })();
  }, [sendVoice]);
  listenLoopRef.current = listenLoop;

  const toggleVoiceMode = useCallback(() => {
    if (voiceModeRef.current) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      utteranceRef.current?.cancel();
      stopSpeaking();
      return;
    }
    voiceModeRef.current = true;
    voiceLangRef.current = voiceLang;
    setVoiceMode(true);
    stopSpeaking();
    listenRef.current?.stop();
    listenLoop();
  }, [voiceLang, listenLoop]);

  const toggleListening = useCallback(() => {
    if (listening) {
      listenRef.current?.stop();
      utteranceRef.current?.stop();
      return;
    }
    stopSpeaking();
    const lang = voiceLang === "auto" ? i18n.language || navigator.language : voiceLang;

    if (!voiceInputSupported()) {
      // No native engine (Firefox etc.): one-shot record → server Whisper.
      setListening(true);
      void (async () => {
        const prosodyPromise = startProsodyCapture();
        const blob = await recordUtterance({ onHandle: (h) => (utteranceRef.current = h) });
        const capture = await prosodyPromise;
        setListening(false);
        if (!blob) {
          capture?.stop();
          return;
        }
        const result = await transcribe(blob, voiceLang);
        if (result?.text) {
          voiceRepliesRef.current = true;
          prosodyRef.current = capture;
          sendVoice(result.text);
        } else {
          capture?.stop();
        }
      })();
      return;
    }

    const session = listen(lang, {
      onInterim: (text) => setInput(text),
      onFinal: (text) => {
        voiceRepliesRef.current = true; // spoke → gets spoken replies
        sendVoice(text);
      },
      // Listening ended without a clean final result — keep whatever was
      // heard in the composer so the user can edit or press Send.
      onPartial: (text) => setInput(text),
      onDenied: () => {
        // PRD: silent fallback to text. No error message shown.
        setVoiceAvailable(false);
      },
      onEnd: () => setListening(false),
    });
    if (session) {
      listenRef.current = session;
      setListening(true);
      void startProsodyCapture().then((capture) => {
        prosodyRef.current = capture;
      });
    } else {
      setVoiceAvailable(false);
    }
  }, [listening, i18n.language, voiceLang, sendVoice]);

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
          <div className="pillars">
            <div className="pillar">
              <h3>{t("landing.pillar1Title")}</h3>
              <p>{t("landing.pillar1Text")}</p>
            </div>
            <div className="pillar">
              <h3>{t("landing.pillar2Title")}</h3>
              <p>{t("landing.pillar2Text")}</p>
            </div>
            <div className="pillar">
              <h3>{t("landing.pillar3Title")}</h3>
              <p>{t("landing.pillar3Text")}</p>
            </div>
          </div>
          <p className="reassure">{t("landing.reassurance")}</p>
        </main>
        <HumanDoor
          onOpen={() => {
            void fetchSupportOptions().then(setSupportOptions);
            setSupportOpen(true);
          }}
        />
        <footer className="land-links">
          <a href="/counsellor/">{t("landing.counsellorLink")}</a>
          <a href="https://github.com/sandeshdevx/zenith" target="_blank" rel="noreferrer">
            {t("landing.github")}
          </a>
        </footer>
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

        {connectFailed && (
          <div className="offline-card">
            <p>{t("chat.offline")}</p>
            <div className="offline-lines">
              <a href="tel:+919152987821">iCall · +91 91529 87821</a>
              <a href="tel:+919999666555">Vandrevala 24x7 · +91 99996 66555</a>
              <a href="https://wa.me/919999666555" target="_blank" rel="noreferrer">
                Vandrevala WhatsApp
              </a>
              <a href="https://www.7cups.com/talk-to-someone-now/" target="_blank" rel="noreferrer">
                7 Cups
              </a>
            </div>
            <button className="retry" onClick={() => void begin()}>
              {t("chat.retry")}
            </button>
          </div>
        )}
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
            placeholder={listening ? t("chat.listeningMic") : t("chat.placeholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {voiceAvailable && (
            <button
              className={`mic ${listening ? "mic-live" : ""}`}
              aria-label={t("chat.mic")}
              onClick={toggleListening}
            >
              ●
            </button>
          )}
          {voiceAvailable && (
            <button
              className="voice-mode-btn"
              aria-label={t("voiceMode.start")}
              onClick={toggleVoiceMode}
            >
              ∿
            </button>
          )}
          <button className="send" disabled={!input.trim() || connectFailed} onClick={send}>
            {t("chat.send")}
          </button>
        </div>
        <div className="composer-hints">
          {voiceAvailable && (
            <label className="voice-lang">
              {t("chat.voiceLang")}
              <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}>
                <option value="auto">{t("chat.voiceLangAuto")}</option>
                <option value="en-IN">English</option>
                <option value="hi-IN">हिन्दी</option>
                <option value="ta-IN">தமிழ்</option>
                <option value="te-IN">తెలుగు</option>
                <option value="bn-IN">বাংলা</option>
                <option value="mr-IN">मराठी</option>
                <option value="kn-IN">ಕನ್ನಡ</option>
              </select>
            </label>
          )}
          {voiceUnsupported && <span className="voice-hint">{t("chat.voiceUnsupported")}</span>}
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
      {voiceMode && (
        <div className="voice-veil">
          <div className={`voice-orb orb-${voicePhase}`} aria-hidden />
          <p className="voice-phase">{t(`voiceMode.${voicePhase}`)}</p>
          <p className="voice-last">
            {messages.length > 0 ? messages[messages.length - 1]?.content : ""}
          </p>
          <button className="voice-end" onClick={toggleVoiceMode}>
            {t("voiceMode.end")}
          </button>
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
