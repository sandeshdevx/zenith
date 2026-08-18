import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertPayload, CounsellorServerFrame } from "@zenith/contracts";
import {
  acceptSession,
  CounsellorRealtime,
  declineSession,
  fetchQueue,
  requestLink,
  setAvailability,
  verifyLink,
} from "./api.js";

type Stage = "email" | "verify" | "ready";
type ThemeMode = "light" | "dark" | "system";

interface ActiveCall {
  sessionId: string;
  roomUrl: string;
}

function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    return (localStorage.getItem("zenith-counsellor-theme") as ThemeMode) || "dark";
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
    localStorage.setItem("zenith-counsellor-theme", theme);

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
    setTheme((prev) => (prev === "dark" ? "light" : prev === "light" ? "system" : "dark"));
  };

  return { theme, cycleTheme };
}

export default function App() {
  const { t } = useTranslation();
  const { theme, cycleTheme } = useTheme();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [linkToken, setLinkToken] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [alerts, setAlerts] = useState<AlertPayload[]>([]);
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [calls, setCalls] = useState<ActiveCall[]>([]);
  const rtRef = useRef<CounsellorRealtime | null>(null);

  const onFrame = useCallback((frame: CounsellorServerFrame) => {
    if (frame.type === "counsellor.alerted") {
      setAlerts((a) =>
        a.some((x) => x.alertId === frame.alert.alertId) ? a : [...a, frame.alert],
      );
    } else if (frame.type === "counsellor.accepted") {
      setAlerts((a) => a.filter((x) => x.alertId !== frame.alertId));
    } else if (frame.type === "alert.expired") {
      setAlerts((a) => a.filter((x) => x.alertId !== frame.alertId));
    }
  }, []);

  const login = useCallback(async () => {
    setError("");
    const result = await verifyLink(linkToken.trim(), totpCode.trim() || undefined);
    if (result.ok) {
      setStage("ready");
      const rt = new CounsellorRealtime(onFrame);
      rtRef.current = rt;
      rt.connect();
      setAlerts(await fetchQueue());
    } else if (result.totpRequired) {
      setNeedsTotp(true);
      setError(t("login.totpNeeded"));
    } else {
      setError(t("login.invalid"));
    }
  }, [linkToken, totpCode, onFrame, t]);

  useEffect(() => () => rtRef.current?.stop(), []);

  // LOGIN SCREEN
  if (stage !== "ready") {
    return (
      <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--color-text)] flex flex-col items-center justify-center p-4 transition-colors">
        <div className="absolute top-4 right-4">
          <button
            onClick={cycleTheme}
            className="text-xs font-medium text-[var(--color-dim)] bg-[var(--bg-panel)] border border-[var(--border-line)] px-3 py-1.5 rounded-full"
          >
            {theme === "dark" ? "🌙 Dark" : theme === "light" ? "☀️ Light" : "🌗 System"}
          </button>
        </div>

        <main className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-line)] rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="w-8 h-8 rounded-lg bg-[var(--color-teal)] text-white flex items-center justify-center font-bold text-lg">
              Z
            </span>
            <h1 className="font-serif text-3xl font-medium text-[var(--color-text)]">
              Zenith
            </h1>
          </div>
          <p className="text-sm text-[var(--color-dim)] mb-6">
            {t("login.tagline")} — Counsellor Workbench
          </p>

          {stage === "email" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="counsellor-email" className="block text-xs text-[var(--color-dim)] mb-1.5 font-medium">
                  {t("login.email")}
                </label>
                <input
                  id="counsellor-email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="counsellor@zenith.org"
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-[var(--bg-canvas)] border border-[var(--border-line)] text-[var(--color-text)] placeholder-[var(--color-dim)] rounded-xl px-4 py-3 text-base focus:border-[var(--color-teal)] outline-none transition-colors"
                />
              </div>
              <button
                disabled={!email.includes("@")}
                onClick={() => {
                  void requestLink(email);
                  setStage("verify");
                }}
                className="w-full bg-[var(--color-teal)] hover:opacity-90 disabled:opacity-40 text-white font-semibold py-3 px-4 rounded-xl transition-colors text-base"
              >
                {t("login.sendLink")}
              </button>
            </div>
          )}

          {stage === "verify" && (
            <div className="space-y-4">
              <p className="text-xs text-[var(--color-dim)] bg-[var(--bg-canvas)] p-3 rounded-lg border border-[var(--border-line)]">
                {t("login.tokenHint")}
              </p>
              <div>
                <label htmlFor="token-input" className="block text-xs text-[var(--color-dim)] mb-1.5 font-medium">
                  {t("login.token")}
                </label>
                <input
                  id="token-input"
                  value={linkToken}
                  spellCheck={false}
                  placeholder="Paste access token…"
                  onChange={(e) => setLinkToken(e.target.value)}
                  className="w-full bg-[var(--bg-canvas)] border border-[var(--border-line)] text-[var(--color-text)] placeholder-[var(--color-dim)] rounded-xl px-4 py-3 text-base focus:border-[var(--color-teal)] outline-none transition-colors"
                />
              </div>

              {needsTotp && (
                <div>
                  <label htmlFor="totp-input" className="block text-xs text-[var(--color-dim)] mb-1.5 font-medium">
                    {t("login.totp")}
                  </label>
                  <input
                    id="totp-input"
                    value={totpCode}
                    inputMode="numeric"
                    placeholder="6-digit code"
                    onChange={(e) => setTotpCode(e.target.value)}
                    className="w-full bg-[var(--bg-canvas)] border border-[var(--border-line)] text-[var(--color-text)] placeholder-[var(--color-dim)] rounded-xl px-4 py-3 text-base focus:border-[var(--color-teal)] outline-none transition-colors"
                  />
                </div>
              )}

              <button
                disabled={linkToken.length < 10}
                onClick={() => void login()}
                className="w-full bg-[var(--color-teal)] hover:opacity-90 disabled:opacity-40 text-white font-semibold py-3 px-4 rounded-xl transition-colors text-base"
              >
                {t("login.signIn")}
              </button>

              {error && <p className="text-xs text-[#c64545] font-medium">{error}</p>}
            </div>
          )}
        </main>
      </div>
    );
  }

  const visibleAlerts = alerts.filter((a) => !declined.has(a.alertId));

  // READY COUNSELLOR WORKBENCH
  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--color-text)] flex flex-col transition-colors">
      <header className="border-b border-[var(--border-line)] bg-[var(--bg-panel)]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-md bg-[var(--color-teal)] text-white flex items-center justify-center font-bold text-sm">
              Z
            </span>
            <span className="font-serif text-xl text-[var(--color-text)] font-medium">
              Zenith · {t("queue.title")}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={cycleTheme}
              className="text-xs font-medium text-[var(--color-dim)] bg-[var(--bg-canvas)] border border-[var(--border-line)] px-3 py-1.5 rounded-full"
              title={`Theme: ${theme}`}
            >
              {theme === "dark" ? "🌙 Dark" : theme === "light" ? "☀️ Light" : "🌗 System"}
            </button>

            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none text-xs sm:text-sm font-medium">
              <input
                type="checkbox"
                checked={available}
                onChange={(e) => {
                  setAvailable(e.target.checked);
                  void setAvailability(e.target.checked);
                }}
                className="w-4 h-4 rounded accent-[var(--color-teal)]"
              />
              <span className={available ? "text-[var(--color-teal)]" : "text-[var(--color-dim)]"}>
                {available ? t("queue.available") : t("queue.unavailable")}
              </span>
            </label>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-8 space-y-6">
        {/* Active Calls Section */}
        {calls.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs uppercase font-semibold tracking-wider text-[var(--color-dim)]">
              Active Sessions
            </h2>
            {calls.map((c) => (
              <div
                key={c.sessionId}
                className="bg-[var(--color-teal)]/10 border border-[var(--color-teal)]/30 rounded-xl p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-teal)]">
                  <span className="w-2 h-2 rounded-full bg-[#52b788] animate-ping" />
                  <span>{t("queue.inSession")} · {c.sessionId.slice(0, 8)}…</span>
                </div>
                <div className="flex items-center gap-3">
                  <a
                    href={c.roomUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-[var(--color-teal)] text-white text-xs font-semibold px-4 py-2 rounded-lg hover:opacity-90 transition-colors"
                  >
                    {t("queue.rejoin")}
                  </a>
                  <button
                    onClick={() => setCalls((x) => x.filter((y) => y.sessionId !== c.sessionId))}
                    className="text-xs text-[var(--color-dim)] hover:text-[var(--color-text)] border border-[var(--border-line)] px-3 py-2 rounded-lg"
                  >
                    {t("queue.done")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Queue Alerts Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase font-semibold tracking-wider text-[var(--color-dim)]">
              Incoming Escalation Queue
            </h2>
            <span className="text-xs text-[var(--color-dim)]">
              {visibleAlerts.length} pending alert{visibleAlerts.length === 1 ? "" : "s"}
            </span>
          </div>

          {visibleAlerts.length === 0 && (
            <div className="bg-[var(--bg-panel)] border border-[var(--border-line)] rounded-2xl p-12 text-center text-[var(--color-dim)] font-serif text-base">
              {t("queue.empty")}
            </div>
          )}

          {visibleAlerts.map((alert) => (
            <article
              key={alert.alertId}
              className={`bg-[var(--bg-panel)] border border-[var(--border-line)] border-l-4 rounded-xl p-5 space-y-4 ${
                alert.tier === "red"
                  ? "border-l-[#c64545]"
                  : alert.tier === "orange"
                  ? "border-l-[#e07a5f]"
                  : "border-l-[#52b788]"
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className={`font-semibold uppercase tracking-wider px-2 py-0.5 rounded text-[11px] ${
                      alert.tier === "red"
                        ? "bg-[#c64545]/20 text-[#c64545]"
                        : alert.tier === "orange"
                        ? "bg-[#e07a5f]/20 text-[#e07a5f]"
                        : "bg-[#52b788]/20 text-[#52b788]"
                    }`}
                  >
                    {alert.tier.toUpperCase()} TIER
                  </span>
                  <span className="text-[var(--color-dim)] font-mono">
                    ID: {alert.sessionId.slice(0, 8)}…
                  </span>
                </div>
                <Countdown until={alert.expiresAt} />
              </div>

              {/* Chat preview turns */}
              <div className="bg-[var(--preview-bg)] border border-[var(--border-line)] rounded-lg p-3 space-y-2 max-h-48 overflow-y-auto">
                {alert.lastTurns.map((turn, i) => (
                  <div key={i} className="text-xs leading-relaxed flex gap-2">
                    <span className="font-mono uppercase text-[var(--color-dim)] shrink-0 text-[10px] pt-0.5">
                      {turn.sender === "user" ? t("queue.them") : t("queue.buddy")}:
                    </span>
                    <span className={turn.sender === "user" ? "text-[var(--color-text)]" : "text-[var(--color-dim)]"}>
                      {turn.content}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => {
                    void acceptSession(alert.sessionId).then((res) => {
                      if (res) {
                        setCalls((c) => [...c, { sessionId: alert.sessionId, roomUrl: res.roomUrl }]);
                        setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
                        window.open(res.roomUrl, "_blank", "noopener");
                      } else {
                        setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
                      }
                    });
                  }}
                  className="bg-[var(--color-teal)] hover:opacity-90 text-white font-semibold text-xs py-2.5 px-5 rounded-lg transition-colors"
                >
                  {t("queue.accept")} & Connect
                </button>
                <button
                  onClick={() => {
                    setDeclined((d) => new Set(d).add(alert.alertId));
                    void declineSession(alert.sessionId);
                  }}
                  className="border border-[var(--border-line)] hover:bg-[var(--bg-canvas)] text-[var(--color-dim)] text-xs font-medium py-2.5 px-4 rounded-lg transition-colors"
                >
                  {t("queue.decline")}
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}

function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(until).getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, new Date(until).getTime() - Date.now())), 1000);
    return () => clearInterval(id);
  }, [until]);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span className="font-mono text-xs text-[#e07a5f] tabular-nums">
      ⏱️ {m}:{String(s).padStart(2, "0")} remaining
    </span>
  );
}
