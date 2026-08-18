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
  getTtsUrl,
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
type ThemeMode = "light" | "dark" | "system";

interface ChatMessage {
  key: string;
  sender: "user" | "buddy" | "counsellor";
  content: string;
}

let keyCounter = 0;
const nextKey = () => `m${++keyCounter}`;

function detectTextLanguage(text: string): string | null {
  const scripts: [RegExp, string][] = [
    [/[\u0900-\u097F]/, "hi"],
    [/[\u0C00-\u0C7F]/, "te"],
    [/[\u0980-\u09FF]/, "bn"],
    [/[\u0B80-\u0BFF]/, "ta"],
    [/[\u0C80-\u0CFF]/, "kn"],
    [/[\u0D00-\u0D7F]/, "ml"],
    [/[\u0A00-\u0A7F]/, "pa"],
    [/[\u0A80-\u0AFF]/, "gu"],
    [/[\u0B00-\u0B7F]/, "or"],
    [/[\u0600-\u06FF]/, "ur"],
    [/[\u4E00-\u9FFF]/, "zh"],
    [/[\u3040-\u30FF]/, "ja"],
    [/[\uAC00-\uD7AF]/, "ko"],
    [/[\u0400-\u04FF]/, "ru"],
  ];
  for (const [re, lang] of scripts) {
    if (re.test(text)) return lang;
  }
  return null;
}

function ZenithSpikeIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 2C12 7.52285 7.52285 12 2 12C7.52285 12 12 16.4771 12 22C12 16.4771 16.4771 12 22 12C16.4771 12 12 7.52285 12 2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    return (localStorage.getItem("zenith-theme") as ThemeMode) || "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => {
      let isDark = theme === "dark";
      if (theme === "system") {
        isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
      if (isDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    updateTheme();
    localStorage.setItem("zenith-theme", theme);

    if (theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = (e: MediaQueryListEvent) => {
        if (e.matches) root.classList.add("dark");
        else root.classList.remove("dark");
      };
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }
  }, [theme]);

  const cycleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : prev === "dark" ? "system" : "light"));
  };

  return { theme, setTheme, cycleTheme };
}

export default function App() {
  const { t } = useTranslation();
  const { theme, cycleTheme } = useTheme();
  const [phase, setPhase] = useState<Phase>("landing");
  const [status, setStatus] = useState<Status>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportOptions, setSupportOptions] = useState<SupportOption[]>([]);
  const [handoffOffer, setHandoffOffer] = useState<string | null>(null);
  const [videoRoom, setVideoRoom] = useState<string | null>(null);
  const [waitingForHuman, setWaitingForHuman] = useState(false);
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
  const [voiceMode, setVoiceMode] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("listening");
  const voiceModeRef = useRef(false);
  const voiceLangRef = useRef("auto");
  const spokenLangRef = useRef<string>("");
  const utteranceRef = useRef<UtteranceHandle | null>(null);
  const listenLoopRef = useRef<() => void>(() => {});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const speakNaturally = useCallback((text: string, lang: string, onEnd: () => void) => {
    const url = getTtsUrl(text, lang);
    if (!url) {
      speak(text, lang, onEnd);
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      speak(text, lang, onEnd);
    };
    audio.onended = () => {
      if (!settled) {
        settled = true;
        onEnd();
      }
    };
    audio.onerror = fallback;
    void audio.play().catch(fallback);
  }, []);

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
      if (frame.sender !== "user" && voiceModeRef.current) {
        const replyLang = detectTextLanguage(frame.content) ?? spokenLangRef.current;
        if (replyLang !== spokenLangRef.current) spokenLangRef.current = replyLang;
        setVoicePhase("speaking");
        speakNaturally(frame.content, replyLang, () => {
          if (voiceModeRef.current) listenLoopRef.current();
        });
      } else if (frame.sender !== "user" && voiceRepliesRef.current) {
        const replyLang = detectTextLanguage(frame.content) ?? spokenLangRef.current;
        speakNaturally(frame.content, replyLang, () => {});
      }
    } else if (frame.type === "handoff.offer") {
      setHandoffOffer(frame.roomUrl);
      setWaitingForHuman(false);
    } else if (frame.type === "session.ended") {
      setPhase("ended");
    }
  }, [speakNaturally]);

  const onResync = useCallback((history: SessionMessage[]) => {
    setMessages(
      history.map((m) => ({ key: `db-${m.messageId}`, sender: m.sender, content: m.content })),
    );
  }, []);

  const begin = useCallback(async () => {
    setPhase("chat");
    setConnectFailed(false);
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
    const prosody = prosodyRef.current?.stop() ?? undefined;
    prosodyRef.current = null;
    clientRef.current?.sendMessage(content, prosody ?? undefined);
  }, []);

  const listenLoop = useCallback(() => {
    if (!voiceModeRef.current) return;
    setVoicePhase("listening");

    if (voiceInputSupported()) {
      const lang = voiceLangRef.current === "auto" ? "" : voiceLangRef.current;
      let finalFired = false;

      const session = listen(lang, {
        onInterim: () => {},
        onFinal: (text) => {
          finalFired = true;
          if (!voiceModeRef.current) return;
          setVoicePhase("thinking");
          sendVoice(text);
        },
        onPartial: (text) => {
          finalFired = true;
          if (!voiceModeRef.current) return;
          if (text.trim()) {
            setVoicePhase("thinking");
            sendVoice(text);
          } else {
            listenLoopRef.current();
          }
        },
        onDenied: () => {
          voiceModeRef.current = false;
          setVoiceMode(false);
        },
        onEnd: () => {
          if (!finalFired && voiceModeRef.current) listenLoopRef.current();
        },
      });

      if (session) {
        utteranceRef.current = { stop: session.stop, cancel: session.stop };
        return;
      }
    }

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
        if (Date.now() - startedAt < 1000) {
          voiceModeRef.current = false;
          setVoiceMode(false);
          return;
        }
        listenLoopRef.current();
        return;
      }
      setVoicePhase("thinking");
      const langHint = voiceLangRef.current !== "auto" ? voiceLangRef.current : undefined;
      const result = await transcribe(blob, langHint);
      if (!voiceModeRef.current) {
        prosodyCapture?.stop();
        return;
      }
      if (result?.text) {
        if (result.language) spokenLangRef.current = result.language;
        prosodyRef.current = prosodyCapture;
        sendVoice(result.text);
      } else {
        prosodyCapture?.stop();
        await new Promise((r) => setTimeout(r, 2000));
        if (voiceModeRef.current) listenLoopRef.current();
      }
    })();
  }, [sendVoice]);
  listenLoopRef.current = listenLoop;

  const toggleVoiceMode = useCallback(() => {
    if (voiceModeRef.current) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      utteranceRef.current?.cancel();
      audioRef.current?.pause();
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
    const lang = voiceLang === "auto" ? "" : voiceLang;

    if (!voiceInputSupported()) {
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
          if (result.language) spokenLangRef.current = result.language;
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
        voiceRepliesRef.current = true;
        sendVoice(text);
      },
      onPartial: (text) => setInput(text),
      onDenied: () => {
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
  }, [listening, voiceLang, sendVoice]);

  const leave = useCallback(async () => {
    clientRef.current?.stop();
    await endSession();
    setMessages([]);
    setDraft("");
    setPhase("ended");
  }, []);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft, thinking]);

  // Header Nav Component with Theme Switcher
  const HeaderNav = (
    <header className="w-full h-16 border-b border-[var(--border-hairline)] bg-[var(--bg-canvas)]/90 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between px-4 sm:px-8 max-w-6xl mx-auto transition-colors">
      <div className="flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg bg-[var(--color-primary)] text-[#faf9f5] flex items-center justify-center shadow-xs">
          <ZenithSpikeIcon className="w-5 h-5" />
        </span>
        <span className="font-serif text-2xl font-medium tracking-tight text-[var(--color-ink)]">
          Zenith
        </span>
      </div>

      <div className="flex items-center gap-2.5 sm:gap-3">
        {/* Theme Toggle Button */}
        <button
          onClick={cycleTheme}
          aria-label={`Current theme: ${theme}. Click to switch theme.`}
          className="text-xs sm:text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] px-3 py-1.5 rounded-full transition-colors flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          title={`Theme: ${theme}`}
        >
          <span>{theme === "light" ? "☀️" : theme === "dark" ? "🌙" : "🌗"}</span>
          <span className="capitalize hidden sm:inline">{theme}</span>
        </button>

        <button
          onClick={() => {
            void fetchSupportOptions().then(setSupportOptions);
            setSupportOpen(true);
          }}
          className="text-xs sm:text-sm font-medium text-[var(--color-primary)] hover:opacity-90 bg-[var(--color-primary-soft)] border border-[var(--color-primary)]/20 px-3.5 py-1.5 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          {t("support.talkToPerson")}
        </button>

        {phase === "chat" && (
          <button
            onClick={() => void leave()}
            className="text-xs sm:text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] px-2.5 py-1.5 rounded-md transition-colors"
          >
            {t("chat.endSession")}
          </button>
        )}
      </div>
    </header>
  );

  // LANDING PAGE VIEW
  if (phase === "landing") {
    return (
      <div className="min-h-screen flex flex-col shell-bg text-[var(--color-ink)] bg-[var(--bg-canvas)] transition-colors">
        {HeaderNav}

        <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-12 sm:py-20 flex flex-col items-center text-center animate-rise">
          {/* Badge Pill */}
          <div className="inline-flex items-center gap-2 bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] px-3.5 py-1.5 rounded-full mb-6">
            <span className="w-2 h-2 rounded-full bg-[#52b788] animate-breathe" aria-hidden="true" />
            <span className="font-sans text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-body)]">
              Private • Free • Anonymous 24/7 Support
            </span>
          </div>

          {/* Hero Display Headline */}
          <h1 className="font-serif font-normal text-4xl sm:text-6xl md:text-7xl text-[var(--color-ink)] tracking-tight leading-[1.08] max-w-3xl text-balance mb-6">
            {t("landing.title")}
          </h1>

          {/* Subtitle */}
          <p className="font-sans text-lg sm:text-xl text-[var(--color-ink-body)] font-normal leading-relaxed max-w-2xl text-pretty mb-8">
            {t("landing.subtitle")}
          </p>

          {/* Primary CTA Button */}
          <button
            onClick={() => void begin()}
            className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.99] text-[#ffffff] font-medium text-base sm:text-lg px-8 py-4 rounded-xl shadow-md hover:shadow-lg transition-all transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 cursor-pointer mb-6"
          >
            {t("landing.start")} →
          </button>

          {/* Reassurance text */}
          <p className="text-xs sm:text-sm text-[var(--color-ink-muted)] max-w-md mb-16 leading-normal">
            🔒 {t("landing.reassurance")}
          </p>

          {/* Feature Pillars Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full text-left">
            <div className="bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] rounded-xl p-6 sm:p-8 transition-colors hover:border-[var(--color-primary)]/40">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)] flex items-center justify-center mb-4 text-xl">
                🌿
              </div>
              <h2 className="font-serif text-xl font-normal text-[var(--color-ink)] mb-2">
                {t("landing.pillar1Title")}
              </h2>
              <p className="text-sm text-[var(--color-ink-body)] leading-relaxed">
                {t("landing.pillar1Text")}
              </p>
            </div>

            <div className="bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] rounded-xl p-6 sm:p-8 transition-colors hover:border-[var(--color-primary)]/40">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)] flex items-center justify-center mb-4 text-xl">
                🤝
              </div>
              <h2 className="font-serif text-xl font-normal text-[var(--color-ink)] mb-2">
                {t("landing.pillar2Title")}
              </h2>
              <p className="text-sm text-[var(--color-ink-body)] leading-relaxed">
                {t("landing.pillar2Text")}
              </p>
            </div>

            <div className="bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] rounded-xl p-6 sm:p-8 transition-colors hover:border-[var(--color-primary)]/40">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)] flex items-center justify-center mb-4 text-xl">
                🛡️
              </div>
              <h2 className="font-serif text-xl font-normal text-[var(--color-ink)] mb-2">
                {t("landing.pillar3Title")}
              </h2>
              <p className="text-sm text-[var(--color-ink-body)] leading-relaxed">
                {t("landing.pillar3Text")}
              </p>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="w-full py-8 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] text-center text-xs sm:text-sm text-[var(--color-ink-muted)] mt-auto transition-colors">
          <div className="max-w-4xl mx-auto px-4 flex flex-wrap items-center justify-center gap-6">
            <a href="/counsellor/" className="hover:text-[var(--color-primary)] transition-colors underline decoration-[var(--color-primary)]/30 underline-offset-4">
              {t("landing.counsellorLink")}
            </a>
            <span>•</span>
            <a
              href="https://github.com/sandeshdevx/zenith"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--color-primary)] transition-colors underline decoration-[var(--color-primary)]/30 underline-offset-4"
            >
              {t("landing.github")}
            </a>
          </div>
        </footer>

        {supportOpen && (
          <SupportPanel options={supportOptions} onClose={() => setSupportOpen(false)} />
        )}
      </div>
    );
  }

  // ENDED VIEW
  if (phase === "ended") {
    return (
      <div className="min-h-screen flex flex-col shell-bg text-[var(--color-ink)] bg-[var(--bg-canvas)] transition-colors">
        {HeaderNav}
        <main className="flex-1 flex items-center justify-center px-4 py-12 text-center animate-rise">
          <div className="bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] rounded-2xl p-8 max-w-md w-full shadow-sm">
            <div className="w-12 h-12 rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)] flex items-center justify-center mx-auto mb-4 text-2xl">
              🌱
            </div>
            <h2 className="font-serif text-2xl font-normal mb-3 text-[var(--color-ink)]">
              Session Ended
            </h2>
            <p className="font-serif text-base text-[var(--color-ink-body)] leading-relaxed mb-6">
              {t("chat.endedNote")}
            </p>
            <button
              onClick={() => void begin()}
              className="bg-[var(--color-primary)] hover:opacity-90 text-[#ffffff] font-medium px-6 py-3 rounded-xl transition-colors w-full"
            >
              Start New Conversation
            </button>
          </div>
        </main>
      </div>
    );
  }

  // ACTIVE CHAT VIEW
  return (
    <div className="min-h-screen flex flex-col shell-bg text-[var(--color-ink)] bg-[var(--bg-canvas)] transition-colors">
      {HeaderNav}

      <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-4 flex flex-col min-h-0">
        {/* Chat Status Sub-Header */}
        <div className="flex items-center justify-between py-2 border-b border-[var(--border-hairline)] text-xs text-[var(--color-ink-muted)]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#52b788] animate-breathe" aria-hidden="true" />
            <span className="font-medium text-[var(--color-ink)]">
              {status === "online" ? "Zenith • Active" : t(status === "connecting" ? "chat.connecting" : "chat.reconnecting")}
            </span>
          </div>

          {voiceAvailable && (
            <div className="flex items-center gap-2">
              <label htmlFor="voice-lang-select" className="text-xs text-[var(--color-ink-muted)]">
                {t("chat.voiceLang")}:
              </label>
              <select
                id="voice-lang-select"
                value={voiceLang}
                onChange={(e) => setVoiceLang(e.target.value)}
                className="bg-[var(--bg-surface-card)] text-[var(--color-ink)] border border-[var(--border-hairline)] rounded-md text-xs px-2 py-1 focus:outline-none focus:border-[var(--color-primary)]"
              >
                <option value="auto">{t("chat.voiceLangAuto")}</option>
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">हिन्दी (Hindi)</option>
                <option value="ta-IN">தமிழ் (Tamil)</option>
                <option value="te-IN">తెలుగు (Telugu)</option>
                <option value="bn-IN">বাংলা (Bengali)</option>
                <option value="mr-IN">मराठी (Marathi)</option>
                <option value="kn-IN">ಕನ್ನಡ (Kannada)</option>
              </select>
            </div>
          )}
        </div>

        {/* Offline Fallback Card */}
        {connectFailed && (
          <div className="bg-[#e07a5f]/10 border border-[#e07a5f]/30 rounded-xl p-5 my-4 animate-rise">
            <p className="text-sm text-[var(--color-ink)] font-medium mb-3">
              {t("chat.offline")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
              <a
                href="tel:+919152987821"
                className="bg-[var(--color-primary)] text-[#ffffff] text-xs font-semibold py-2 px-3 rounded-lg text-center hover:opacity-90 transition-colors"
              >
                iCall · +91 91529 87821
              </a>
              <a
                href="tel:+919999666555"
                className="bg-[var(--color-primary)] text-[#ffffff] text-xs font-semibold py-2 px-3 rounded-lg text-center hover:opacity-90 transition-colors"
              >
                Vandrevala 24x7 · +91 99996 66555
              </a>
              <a
                href="https://wa.me/919999666555"
                target="_blank"
                rel="noreferrer"
                className="bg-[var(--bg-surface-card)] text-[var(--color-ink)] border border-[var(--border-hairline)] text-xs font-medium py-2 px-3 rounded-lg text-center hover:bg-[var(--bg-surface-soft)] transition-colors"
              >
                Vandrevala WhatsApp
              </a>
              <a
                href="https://www.7cups.com/talk-to-someone-now/"
                target="_blank"
                rel="noreferrer"
                className="bg-[var(--bg-surface-card)] text-[var(--color-ink)] border border-[var(--border-hairline)] text-xs font-medium py-2 px-3 rounded-lg text-center hover:bg-[var(--bg-surface-soft)] transition-colors"
              >
                7 Cups Online
              </a>
            </div>
            <button
              onClick={() => void begin()}
              className="text-xs font-medium text-[var(--color-primary)] underline hover:opacity-80"
            >
              {t("chat.retry")}
            </button>
          </div>
        )}

        {/* Message Stream */}
        <div ref={streamRef} className="flex-1 overflow-y-auto stream-scroll py-6 space-y-5">
          {messages.map((m) =>
            m.sender === "user" ? (
              <div key={m.key} className="flex justify-end animate-rise">
                <div className="bg-[var(--user-bubble-bg)] border border-[var(--user-bubble-border)] text-[var(--user-bubble-text)] rounded-2xl rounded-tr-xs px-5 py-3.5 max-w-[85%] sm:max-w-[75%] text-base leading-relaxed whitespace-pre-wrap shadow-2xs">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={m.key} className="flex justify-start animate-rise">
                <div className="bg-[var(--buddy-bubble-bg)] border border-[var(--buddy-bubble-border)] text-[var(--buddy-bubble-text)] font-serif rounded-2xl rounded-tl-xs px-5 py-4 max-w-[85%] sm:max-w-[75%] text-lg leading-relaxed whitespace-pre-wrap shadow-2xs">
                  {m.content}
                </div>
              </div>
            ),
          )}

          {draft && (
            <div className="flex justify-start animate-rise">
              <div className="bg-[var(--buddy-bubble-bg)] border border-[var(--buddy-bubble-border)] text-[var(--buddy-bubble-text)] font-serif rounded-2xl rounded-tl-xs px-5 py-4 max-w-[85%] sm:max-w-[75%] text-lg leading-relaxed whitespace-pre-wrap shadow-2xs">
                {draft}
              </div>
            </div>
          )}

          {thinking && !draft && (
            <div className="flex items-center gap-2.5 text-[var(--color-ink-muted)] font-serif italic text-base py-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#52b788] animate-breathe" aria-hidden="true" />
              <span>Thinking & listening…</span>
            </div>
          )}

          {waitingForHuman && !handoffOffer && (
            <div className="flex items-center gap-2.5 text-[var(--color-primary)] font-serif italic text-base py-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#52b788] animate-breathe" aria-hidden="true" />
              <span>{t("handoff.finding")}</span>
            </div>
          )}

          {handoffOffer && (
            <div className="bg-[var(--bg-surface-card)] border border-[var(--color-primary)]/30 rounded-xl p-4 my-2 flex items-center justify-between gap-4 animate-rise">
              <span className="text-sm font-medium text-[var(--color-ink)]">
                A human counsellor is available for private call.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    void acceptHandoff().then((room) => {
                      if (room) setVideoRoom(room);
                      setHandoffOffer(null);
                    });
                  }}
                  className="bg-[var(--color-primary)] text-[#ffffff] text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-colors"
                >
                  {t("handoff.accept")}
                </button>
                <button
                  onClick={() => {
                    setHandoffOffer(null);
                    void declineHandoff();
                  }}
                  className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] px-3 py-2"
                >
                  {t("handoff.decline")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Composer controls */}
        <div className="pt-3 border-t border-[var(--border-hairline)] flex flex-col gap-2">
          <div className="flex items-end gap-2">
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
              className="flex-1 bg-[var(--bg-surface-soft)] text-[var(--color-ink)] placeholder-[var(--color-ink-faint)] border border-[var(--border-hairline)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/20 rounded-xl px-4 py-3 text-base leading-relaxed transition-all resize-none outline-none max-h-32"
            />

            {voiceAvailable && (
              <button
                onClick={toggleListening}
                aria-label={t("chat.mic")}
                className={`w-11 h-11 rounded-full border border-[var(--border-hairline)] flex items-center justify-center text-lg transition-colors ${
                  listening
                    ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)] animate-breathe"
                    : "bg-[var(--bg-surface-card)] text-[var(--color-primary)] hover:bg-[var(--bg-surface-soft)]"
                }`}
              >
                🎙️
              </button>
            )}

            {voiceAvailable && (
              <button
                onClick={toggleVoiceMode}
                aria-label={t("voiceMode.start")}
                className="w-11 h-11 rounded-full bg-[var(--bg-surface-card)] text-[var(--color-primary)] border border-[var(--border-hairline)] hover:bg-[var(--bg-surface-soft)] flex items-center justify-center text-xl font-bold transition-colors"
                title="Hands-free Voice Conversation"
              >
                ∿
              </button>
            )}

            <button
              disabled={!input.trim() || connectFailed}
              onClick={send}
              className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-35 text-[#ffffff] font-medium px-5 py-3 rounded-xl transition-all shadow-xs text-sm"
            >
              {t("chat.send")}
            </button>
          </div>

          {voiceUnsupported && (
            <span className="text-xs text-[var(--color-ink-faint)]">{t("chat.voiceUnsupported")}</span>
          )}
        </div>
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
        <div className="fixed inset-0 z-50 bg-[#121921] flex flex-col">
          <div className="p-3 bg-[#1a2430] border-b border-white/10 flex items-center justify-between">
            <span className="text-white text-sm font-medium">Zenith Counselling Video Call</span>
            <button
              onClick={() => setVideoRoom(null)}
              className="text-xs text-white/80 hover:text-white bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full"
            >
              {t("handoff.backToChat")}
            </button>
          </div>
          <iframe
            src={videoRoom}
            allow="camera; microphone; fullscreen; display-capture"
            title="zenith-call"
            className="flex-1 w-full border-none"
          />
        </div>
      )}

      {/* Hands-free Voice Overlay */}
      {voiceMode && (
        <div className="fixed inset-0 z-50 bg-[#121921] text-[#faf9f5] flex flex-col items-center justify-center p-6 animate-fade">
          <div className="relative mb-8">
            <div
              className={`w-40 h-40 rounded-full bg-radial from-[#52b788] via-[#2d6a4f] to-[#1b4332] shadow-[0_0_90px_rgba(82,183,136,0.4)] ${
                voicePhase === "listening"
                  ? "animate-orb-listening"
                  : voicePhase === "thinking"
                  ? "animate-orb-thinking"
                  : "animate-orb-speaking"
              }`}
            />
          </div>

          <p className="font-serif italic text-2xl text-[#faf9f5] mb-4 tracking-wide">
            {t(`voiceMode.${voicePhase}`)}
          </p>

          <p className="text-sm text-[#a09d96] max-w-md text-center min-h-[3em] leading-relaxed mb-8">
            {messages.length > 0 ? messages[messages.length - 1]?.content : ""}
          </p>

          <button
            onClick={toggleVoiceMode}
            className="border border-[#e6dfd8]/30 hover:border-white text-[#faf9f5] hover:bg-white/10 font-medium px-8 py-3 rounded-full text-sm transition-all"
          >
            {t("voiceMode.end")}
          </button>
        </div>
      )}
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
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--bg-canvas)] border border-[var(--border-hairline)] rounded-t-3xl sm:rounded-2xl p-6 sm:p-8 max-w-lg w-full shadow-2xl animate-rise text-[var(--color-ink)]"
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-serif text-2xl font-normal text-[var(--color-ink)]">
            {t("support.panelTitle")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("support.close")}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] text-xl font-semibold p-1"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 leading-relaxed">
          {t("support.panelNote")}
        </p>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {options
            .filter((o) => o.available)
            .map((o) => (
              <div
                key={o.id}
                className="bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] rounded-xl p-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--color-ink)] leading-snug">
                    {t(o.labelKey)}
                  </div>
                  {o.hours && (
                    <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                      {t("support.hours")}: {o.hours}
                    </div>
                  )}
                </div>

                {o.kind === "phone" && o.phone && (
                  <a
                    href={`tel:${o.phone}`}
                    className="bg-[var(--color-primary)] hover:opacity-90 text-[#ffffff] text-xs font-semibold px-4 py-2 rounded-lg transition-colors shrink-0"
                  >
                    {t("support.call")}
                  </a>
                )}
                {o.kind === "link" && o.url && (
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-[var(--color-primary)] hover:opacity-90 text-[#ffffff] text-xs font-semibold px-4 py-2 rounded-lg transition-colors shrink-0"
                  >
                    {t("support.open")}
                  </a>
                )}
                {o.kind === "video" && onVolunteer && (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      onVolunteer();
                    }}
                    className="bg-[var(--color-primary)] hover:opacity-90 text-[#ffffff] text-xs font-semibold px-4 py-2 rounded-lg transition-colors shrink-0"
                  >
                    {t("support.connect")}
                  </button>
                )}
              </div>
            ))}
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full bg-[var(--bg-surface-soft)] hover:bg-[var(--bg-surface-card)] border border-[var(--border-hairline)] text-[var(--color-ink-body)] font-medium text-sm py-3 rounded-xl transition-colors"
        >
          {t("support.close")}
        </button>
      </div>
    </div>
  );
}
