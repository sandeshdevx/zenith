import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertPayload, CounsellorServerFrame } from "@zenith/contracts";
import {
  acceptSession,
  CounsellorRealtime,
  declineSession,
  fetchQueue,
  setAvailability,
} from "./api.js";
import CrisisMonitor from "./CrisisMonitor.js";
import PipelineVisualization from "./PipelineVisualization.js";

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */
type ThemeMode = "dark" | "light" | "system";

interface ActiveCall {
  sessionId: string;
  roomUrl: string;
}

/* ─────────────────────────────────────────────
   Theme hook
───────────────────────────────────────────── */
function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("zenith-theme") as ThemeMode) ?? "dark",
  );

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#0f1419" : "#faf9f5");
    };
    apply();
    localStorage.setItem("zenith-theme", theme);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  const cycleTheme = () =>
    setTheme((p) => (p === "dark" ? "light" : p === "light" ? "system" : "dark"));

  const label = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System";
  const icon  = theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "🌗";
  return { theme, cycleTheme, label, icon };
}

/* ─────────────────────────────────────────────
   Countdown component
───────────────────────────────────────────── */
function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(() =>
    Math.max(0, new Date(until).getTime() - Date.now()),
  );
  useEffect(() => {
    const id = setInterval(
      () => setLeft(Math.max(0, new Date(until).getTime() - Date.now())),
      1000,
    );
    return () => clearInterval(id);
  }, [until]);

  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const urgent = left < 120_000;

  return (
    <span
      className={`font-mono text-xs tabular-nums ${urgent ? "text-[var(--crisis-red)]" : "text-[var(--color-muted)]"}`}
      aria-live="polite"
      aria-atomic="true"
    >
      ⏱ {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

/* ─────────────────────────────────────────────
   Tier helpers
───────────────────────────────────────────── */
const TIER_META = {
  red:    { label: "RED",    color: "var(--crisis-red)",    bg: "color-mix(in srgb, var(--crisis-red) 12%, transparent)"    },
  orange: { label: "ORANGE", color: "var(--crisis-orange)", bg: "color-mix(in srgb, var(--crisis-orange) 12%, transparent)" },
  green:  { label: "GREEN",  color: "var(--crisis-green)",  bg: "color-mix(in srgb, var(--crisis-green) 12%, transparent)"  },
} as const;

function tierMeta(tier: string) {
  return TIER_META[tier as keyof typeof TIER_META] ?? TIER_META.green;
}

/* ─────────────────────────────────────────────
   Alert card
───────────────────────────────────────────── */
interface AlertCardProps {
  alert: AlertPayload;
  onAccept: (a: AlertPayload) => void;
  onDecline: (a: AlertPayload) => void;
}

function AlertCard({ alert, onAccept, onDecline }: AlertCardProps) {
  const { t } = useTranslation();
  const meta = tierMeta(alert.tier);
  const [accepting, setAccepting] = useState(false);

  return (
    <article
      className="alert-enter bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-2xl overflow-hidden"
      aria-label={`${meta.label} tier crisis alert for session ${alert.sessionId.slice(0, 8)}`}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          {/* Tier badge */}
          <span
            className="text-[10px] font-semibold uppercase tracking-widest px-2.5 py-1 rounded-full"
            style={{ color: meta.color, background: meta.bg }}
          >
            {meta.label}
          </span>
          {/* Session ID */}
          <span className="font-mono text-xs text-[var(--color-muted)]">
            #{alert.sessionId.slice(0, 8)}
          </span>
        </div>
        <Countdown until={alert.expiresAt} />
      </div>

      {/* Chat preview */}
      <div
        className="mx-5 mb-4 bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-xl p-3 space-y-2 max-h-44 overflow-y-auto custom-scroll"
        aria-label="Conversation preview"
      >
        {alert.lastTurns.length === 0 ? (
          <p className="text-xs text-[var(--color-muted)] italic">No preview available.</p>
        ) : (
          alert.lastTurns.map((turn, i) => (
            <div key={i} className="text-xs leading-relaxed flex gap-2 min-w-0">
              <span className="font-mono uppercase text-[var(--color-muted)] shrink-0 text-[10px] pt-0.5 w-10">
                {turn.sender === "user" ? t("queue.them") : t("queue.buddy")}:
              </span>
              <span
                className={`break-words min-w-0 ${turn.sender === "user" ? "text-[var(--color-on-dark)]" : "text-[var(--color-muted)]"}`}
              >
                {turn.content}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Action row */}
      <div className="flex items-center gap-3 px-5 pb-4">
        <button
          onClick={() => {
            setAccepting(true);
            void onAccept(alert);
          }}
          disabled={accepting}
          aria-label={`Accept crisis alert for session ${alert.sessionId.slice(0, 8)}`}
          className="flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold text-white transition-opacity disabled:opacity-50 hover:opacity-90"
          style={{ background: "var(--teal)" }}
        >
          {accepting ? "Connecting…" : `${t("queue.accept")} & Connect`}
        </button>
        <button
          onClick={() => onDecline(alert)}
          aria-label={`Decline crisis alert for session ${alert.sessionId.slice(0, 8)}`}
          className="py-2.5 px-4 rounded-xl text-xs font-medium text-[var(--color-muted)] border border-[var(--border-line)] hover:bg-[var(--bg-dark)] transition-colors"
        >
          {t("queue.decline")}
        </button>
      </div>
    </article>
  );
}

/* ─────────────────────────────────────────────
   Counsellor Workbench (main dashboard)
───────────────────────────────────────────── */
function Workbench() {
  const { t }  = useTranslation();
  const { icon, label, cycleTheme } = useTheme();

  const [available, setAvailableState] = useState(false);
  const [alerts, setAlerts]   = useState<AlertPayload[]>([]);
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [calls, setCalls]     = useState<ActiveCall[]>([]);
  const [wsStatus, setWsStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const rtRef = useRef<CounsellorRealtime | null>(null);

  const onFrame = useCallback((frame: CounsellorServerFrame) => {
    if (frame.type === "counsellor.alerted") {
      setAlerts((a) =>
        a.some((x) => x.alertId === frame.alert.alertId) ? a : [...a, frame.alert],
      );
    } else if (frame.type === "counsellor.accepted" || frame.type === "alert.expired") {
      setAlerts((a) => a.filter((x) => x.alertId !== frame.alertId));
    }
  }, []);

  useEffect(() => {
    const rt = new CounsellorRealtime((frame) => {
      setWsStatus("live");
      onFrame(frame);
    });
    rtRef.current = rt;
    rt.connect();
    void fetchQueue().then(setAlerts);
    return () => rt.stop();
  }, [onFrame]);

  const handleAccept = useCallback(async (alert: AlertPayload) => {
    const res = await acceptSession(alert.sessionId);
    if (res) {
      setCalls((c) => [...c, { sessionId: alert.sessionId, roomUrl: res.roomUrl }]);
      setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
      window.open(res.roomUrl, "_blank", "noopener,noreferrer");
    } else {
      setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
    }
  }, []);

  const handleDecline = useCallback((alert: AlertPayload) => {
    setDeclined((d) => new Set(d).add(alert.alertId));
    void declineSession(alert.sessionId);
  }, []);

  const visibleAlerts = alerts.filter((a) => !declined.has(a.alertId));
  const redCount    = visibleAlerts.filter((a) => a.tier === "red").length;

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--color-ink)] flex flex-col dark:bg-[var(--bg-dark)] dark:text-[var(--color-on-dark)]">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* ── Sticky header ── */}
      <header className="bg-[var(--bg-panel)] border-b border-[var(--border-line)] sticky top-0 z-30" role="banner">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">

          {/* Brand + WS status */}
          <div className="flex items-center gap-3">
            <span
              className="w-8 h-8 rounded-lg flex items-center justify-center font-serif font-bold text-white text-sm"
              style={{ background: "var(--coral)" }}
              aria-hidden="true"
            >
              Z
            </span>
            <span className="font-serif text-lg text-[var(--color-ink)] hidden sm:block dark:text-[var(--color-on-dark)]">
              Zenith Crisis Dashboard
            </span>
            {/* WS indicator */}
            <span
              className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
              aria-label={`WebSocket: ${wsStatus}`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: wsStatus === "live" ? "var(--crisis-green)" : wsStatus === "connecting" ? "var(--crisis-amber)" : "var(--crisis-red)",
                }}
                aria-hidden="true"
              />
              <span className="text-[var(--color-dim)] hidden md:block">{wsStatus}</span>
            </span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3">
            {/* Pending alerts badge */}
            {redCount > 0 && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ color: "var(--crisis-red)", background: "color-mix(in srgb, var(--crisis-red) 15%, transparent)" }}
                aria-live="polite"
              >
                {redCount} critical
              </span>
            )}

            {/* Availability toggle */}
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={available}
                onChange={(e) => {
                  setAvailableState(e.target.checked);
                  void setAvailability(e.target.checked);
                }}
                className="sr-only"
                aria-label={available ? "Set yourself unavailable" : "Set yourself available"}
              />
              <span
                className={`relative w-10 h-5 rounded-full transition-colors ${available ? "bg-[var(--crisis-green)]" : "bg-[var(--border-line)]"}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${available ? "translate-x-5" : "translate-x-0"}`}
                />
              </span>
              <span className={`text-xs font-medium ${available ? "text-[var(--crisis-green)]" : "text-[var(--color-dim)]"}`}>
                {available ? t("queue.available") : t("queue.unavailable")}
              </span>
            </label>

            {/* Theme */}
            <button
              onClick={cycleTheme}
              aria-label={`Switch theme, current: ${label}`}
              className="text-xs font-medium text-[var(--color-dim)] bg-[var(--bg-elevated)] border border-[var(--border-line)] px-2.5 py-1.5 rounded-full hover:text-[var(--color-ink)] transition-colors"
            >
              {icon}
            </button>
          </div>
        </div>
      </header>

      {/* ── Main content ── */}
      <main id="main-content" className="flex-1 max-w-5xl w-full mx-auto px-4 py-7 space-y-7">

        {/* Stat bar */}
        <div className="grid grid-cols-3 gap-3" role="region" aria-label="Queue statistics">
          {[
            { label: "Pending",  value: visibleAlerts.length,                          color: "var(--color-ink)"    },
            { label: "Critical", value: redCount,                                       color: "var(--crisis-red)"   },
            { label: "Active",   value: calls.length,                                   color: "var(--crisis-green)" },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-[var(--bg-panel)] border border-[var(--border-line)] rounded-xl px-4 py-3 text-center"
            >
              <p
                className="font-serif text-3xl tabular-nums"
                style={{ color: s.color }}
                aria-label={`${s.label}: ${s.value}`}
              >
                {s.value}
              </p>
              <p className="text-[11px] text-[var(--color-dim)] uppercase tracking-wider mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Active sessions */}
        {calls.length > 0 && (
          <section aria-label="Active sessions" className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-dim)]">
              Active Sessions
            </h2>
            {calls.map((c) => (
              <div
                key={c.sessionId}
                className="bg-[color-mix(in_srgb,var(--crisis-green)_8%,var(--bg-panel))] border border-[color-mix(in_srgb,var(--crisis-green)_30%,var(--border-line))] rounded-xl p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-2.5 text-sm font-medium min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      background: "var(--crisis-green)",
                      animation: "pulse-ring 1.8s ease-out infinite",
                    }}
                    aria-hidden="true"
                  />
                  <span className="text-[var(--crisis-green)] truncate">
                    {t("queue.inSession")} · #{c.sessionId.slice(0, 8)}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={c.roomUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs font-semibold text-white px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
                    style={{ background: "var(--teal)" }}
                  >
                    {t("queue.rejoin")}
                  </a>
                  <button
                    onClick={() => setCalls((x) => x.filter((y) => y.sessionId !== c.sessionId))}
                    aria-label={`Mark session ${c.sessionId.slice(0, 8)} as done`}
                    className="text-xs text-[var(--color-dim)] hover:text-[var(--color-ink)] border border-[var(--border-line)] px-3 py-2 rounded-lg transition-colors"
                  >
                    {t("queue.done")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Escalation queue - FIRST */}
        <section aria-label="Incoming escalation queue" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-dim)]">
              Escalation Queue
            </h2>
            <span className="text-xs text-[var(--color-dim)] tabular-nums" aria-live="polite">
              {visibleAlerts.length} pending alert{visibleAlerts.length !== 1 ? "s" : ""}
            </span>
          </div>

          {visibleAlerts.length === 0 ? (
            <div
              className="bg-[var(--bg-panel)] border border-[var(--border-line)] rounded-2xl p-14 text-center"
              role="status"
              aria-label="Queue empty"
            >
              <p className="font-serif text-base text-[var(--color-dim)]">
                {t("queue.empty")}
              </p>
              <p className="text-xs text-[var(--color-muted)] mt-1">
                No escalations pending — monitoring continues.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {visibleAlerts.map((alert) => (
                <AlertCard
                  key={alert.alertId}
                  alert={alert}
                  onAccept={handleAccept}
                  onDecline={handleDecline}
                />
              ))}
            </div>
          )}
        </section>

        {/* Crisis monitor - SECOND */}
        <section aria-label="Crisis pipeline monitoring" className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-dim)]">
            {t("crisis.monitorTitle")}
          </h2>
          <CrisisMonitor />
        </section>

        {/* Real-time Pipeline Visualization - THIRD */}
        <section aria-label="Real-time crisis detection pipeline" className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-dim)]">
            {t("pipeline.title")}
          </h2>
          <PipelineVisualization />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border-line)] py-4 px-4 text-center">
        <p className="text-[11px] text-[var(--color-muted)]">
          Zenith Crisis Detection System · All session data is anonymous & zero-retention
        </p>
      </footer>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Root App
───────────────────────────────────────────── */
export default function App() {
  return <Workbench />;
}