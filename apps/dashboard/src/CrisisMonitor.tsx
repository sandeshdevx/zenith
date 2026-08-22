import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */
type SystemHealth = {
  riskWorker: "ONLINE" | "OFFLINE";
  embeddingModel: "ONLINE" | "OFFLINE";
  prosodyEngine: "ONLINE" | "OFFLINE";
  database: "ONLINE" | "OFFLINE";
  api: "ONLINE" | "OFFLINE";
};

type CrisisSession = {
  sessionId: string;
  tier: string;
  csi: number;
  score: number;
  turnCount: number;
  mode: string;
  status: string;
  createdAt: string;
};

type CsiBreakdown = {
  s1: number | null;
  s2: number;
  s3: number | null;
};

type TurnData = {
  turn: number;
  csi: number;
};

const TIER_CONFIG = {
  red:    { color: "var(--crisis-red)",    bg: "color-mix(in srgb, var(--crisis-red) 12%, transparent)",    label: "TIER 4 — CRITICAL" },
  orange: { color: "var(--crisis-orange)", bg: "color-mix(in srgb, var(--crisis-orange) 12%, transparent)", label: "TIER 3 — ELEVATED" },
  yellow: { color: "var(--crisis-amber)",  bg: "color-mix(in srgb, var(--crisis-amber) 12%, transparent)",  label: "TIER 2 — WATCH" },
  green:  { color: "var(--crisis-green)",  bg: "color-mix(in srgb, var(--crisis-green) 12%, transparent)",  label: "TIER 1 — STABLE" },
} as const;

/* ─────────────────────────────────────────────
   Crisis Monitor Component
   ───────────────────────────────────────────── */
export default function CrisisMonitor() {
  const { t } = useTranslation();

  const [systemHealth, setSystemHealth] = useState<SystemHealth>(() => ({
    riskWorker: "ONLINE",
    embeddingModel: "ONLINE",
    prosodyEngine: "ONLINE",
    database: "ONLINE",
    api: "ONLINE",
  }));

  const [sessions, setSessions] = useState<CrisisSession[]>([]);
  const [csiBreakdown, setCsiBreakdown] = useState<CsiBreakdown>({
    s1: null,
    s2: 0,
    s3: null,
  });

  const [turnTimeline, setTurnTimeline] = useState<TurnData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchInitialData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
      const res = await fetch(
        `${apiBase}/api/v1/crisis-monitor`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions || []);

      if (data.sessions && data.sessions.length > 0) {
        const latest = data.sessions[0];
        setCsiBreakdown({
          s1: null,
          s2: latest.csi != null ? Math.round((latest.csi / 100) * 100) : 0,
          s3: null,
        });
      }

      const timeline = buildTimeline(data.sessions || []);
      setTurnTimeline(timeline);
      setLastUpdate(new Date());
    } catch (err: any) {
      setError(err.message || "Failed to fetch crisis monitor data");
      console.error("Crisis monitor fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const buildTimeline = (sessions: CrisisSession[]): TurnData[] => {
    return [];
  };

  const handleReconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    const apiBase = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    const ws = new WebSocket(`${apiBase}/api/v1/counsellor/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Crisis monitor WebSocket connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (frame.type === "counsellor.alerted") {
          fetchInitialData();
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      reconnectTimeoutRef.current = setTimeout(handleReconnect, 3000);
    };
  }, [fetchInitialData]);

  useEffect(() => {
    fetchInitialData();
    handleReconnect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [fetchInitialData, handleReconnect]);

  const formatTimeAgo = (date: Date) => {
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  /* ─────────────────────────────────────────────
     Skeleton Loaders
     ───────────────────────────────────────────── */
  const SystemStatusSkeleton = () => (
    <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-6 animate-pulse">
      <div className="h-4 w-1/3 bg-[var(--border-line)] rounded mb-6" />
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-5 w-24 bg-[var(--border-line)] rounded" />
            <div className="h-3 w-6 bg-[var(--border-line)] rounded-full" />
            <div className="h-3 w-20 bg-[var(--border-line)] rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );

  const SessionCardSkeleton = () => (
    <div className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-xl p-4 flex items-start gap-4 animate-pulse">
      <div className="w-12 h-12 rounded-lg bg-[var(--border-line)] flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-4 w-3/12 bg-[var(--border-line)] rounded" />
        <div className="h-3 w-5/12 bg-[var(--border-line)] rounded" />
      </div>
      <div className="h-5 w-16 bg-[var(--border-line)] rounded shrink-0" />
    </div>
  );

  const CsiBreakdownSkeleton = () => (
    <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-6 animate-pulse">
      <div className="h-4 w-1/3 bg-[var(--border-line)] rounded mb-6" />
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-1/4 bg-[var(--border-line)] rounded" />
            <div className="h-2 bg-[var(--border-line)] rounded-full" />
            <div className="h-3 w-1/5 bg-[var(--border-line)] rounded" />
          </div>
        ))}
        <div className="mt-4 h-8 bg-[var(--border-line)]/50 rounded-xl" />
      </div>
    </div>
  );

  /* ─────────────────────────────────────────────
     Components
     ───────────────────────────────────────────── */
  const StatusIndicator = ({ status, label }: { status: "ONLINE" | "OFFLINE"; label: string }) => {
    const isOnline = status === "ONLINE";
    return (
      <div className="flex items-center gap-3 group">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--color-on-dark)] text-sm">{label}</span>
          <span
            className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
              isOnline ? "bg-[var(--crisis-green)]" : "bg-[var(--crisis-red)]"
            } group-hover:scale-125`}
            aria-hidden="true"
          />
        </div>
        <span
          className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
            isOnline ? "text-[var(--crisis-green)]" : "text-[var(--crisis-red)]"
          }`}
        >
          {status}
        </span>
      </div>
    );
  };

  const SessionCard = ({ session }: { session: CrisisSession }) => {
    const tier = TIER_CONFIG[session.tier as keyof typeof TIER_CONFIG] ?? TIER_CONFIG.green;
    return (
      <article
        className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-xl p-4 flex items-start gap-4 transition-all duration-300 hover:border-[var(--color-primary)]/40 hover:shadow-lg hover:shadow-[var(--color-primary)]/10 group"
        style={{ background: tier.bg }}
      >
        <div
          className="w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center relative overflow-hidden"
        >
          <span className="text-[20px] font-medium text-[var(--color-on-dark)] z-10 relative">
            {session.tier.slice(0, 1).toUpperCase()}
          </span>
          <div
            className="absolute inset-0 bg-[var(--color-on-dark)]/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-medium text-[var(--color-on-dark)] truncated text-sm font-mono">
              #{session.sessionId.slice(0, 8)}
            </p>
            <span
              className={`text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                session.tier === "red" ? "bg-[var(--crisis-red)]/20 text-[var(--crisis-red)]" :
                session.tier === "orange" ? "bg-[var(--crisis-orange)]/20 text-[var(--crisis-orange)]" :
                session.tier === "yellow" ? "bg-[var(--crisis-amber)]/20 text-[var(--crisis-amber)]" :
                "bg-[var(--crisis-green)]/20 text-[var(--crisis-green)]"
              }`}
            >
              {tier.label}
            </span>
          </div>
          <p className="text-xs text-[var(--color-muted)] font-mono tabular-nums">
            Turn {session.turnCount}  •  CSI {session.csi}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <span
            className={`text-xs font-semibold ${session.tier === "red" ? "text-[var(--crisis-red)]" : session.tier === "orange" ? "text-[var(--crisis-orange)]" : session.tier === "yellow" ? "text-[var(--crisis-amber)]" : "text-[var(--crisis-green)]"}`}
          >
            {session.tier.toUpperCase()}
          </span>
        </div>
      </article>
    );
  };

  const SignalBar = ({
    label,
    value,
    max = 100,
    color = "var(--crisis-green)",
    showValue = true,
    description,
  }: {
    label: string;
    value: number;
    max?: number;
    color?: string;
    showValue?: boolean;
    description?: string;
  }) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-[var(--color-on-dark)] text-sm">{label}</span>
          {showValue && (
            <span className="text-xs font-mono tabular-nums text-[var(--color-muted)]">
              {value}/{max}
            </span>
          )}
        </div>
        <div className="w-full bg-[var(--border-line)] rounded-full h-2.5 relative overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${percentage}%`,
              background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 70%, white))`,
              boxShadow: `0 0 8px ${color}`,
            }}
            aria-label={`${label}: ${value}/${max}`}
          />
          {percentage < 100 && (
            <div
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer"
              style={{ animationDuration: "2s" }}
            />
          )}
        </div>
        {description && <p className="text-xs text-[var(--color-muted)]">{description}</p>}
      </div>
    );
  };

  const EmptyState = () => (
    <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-12 text-center">
      <div
        className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--crisis-green)]/10 flex items-center justify-center text-[var(--crisis-green)] text-3xl animate-bounce"
        aria-hidden="true"
      >
        ✓
      </div>
      <p className="font-serif text-lg text-[var(--color-on-dark)] mb-2">{t("crisis.noSessions")}</p>
      <p className="text-sm text-[var(--color-muted)]">All sessions stable — monitoring continues.</p>
    </div>
  );

  const ErrorState = () => (
    <div className="bg-[var(--crisis-red)]/10 border border-[var(--crisis-red)]/30 rounded-2xl p-6 text-center">
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-[var(--crisis-red)]/20 flex items-center justify-center text-[var(--crisis-red)] text-2xl">
        ⚠
      </div>
      <h2 className="font-serif text-lg text-[var(--crisis-red)] mb-2">{t("crisis.error")}</h2>
      <p className="text-sm text-[var(--color-muted)] mb-4">{error}</p>
      <button
        onClick={fetchInitialData}
        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--crisis-red)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
      >
        ↻ {t("crisis.refreshData")}
      </button>
    </div>
  );

  /* ─────────────────────────────────────────────
     Render
     ───────────────────────────────────────────── */
  return (
    <section
      className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-8"
      aria-labelledby="crisis-monitor-title"
      aria-live="polite"
    >
      {/* Header */}
      <header className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--crisis-red)]/10 flex items-center justify-center" aria-hidden="true">
            <svg className="w-5 h-5 text-[var(--crisis-red)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h1 id="crisis-monitor-title" className="font-serif text-xl font-normal text-[var(--color-on-dark)] tracking-tight">
              {t("crisis.monitorTitle")}
            </h1>
            <p className="text-xs text-[var(--color-muted)]">Real-time crisis detection pipeline status</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--color-muted)] text-xs hidden sm:flex">
            <span className="w-2 h-2 rounded-full bg-[var(--crisis-green)] animate-pulse" aria-hidden="true" />
            <span>LIVE</span>
            {lastUpdate && <span className="font-mono">· {formatTimeAgo(lastUpdate)}</span>}
          </div>
          <button
            onClick={fetchInitialData}
            className="px-3 py-2 bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-lg text-sm font-medium text-[var(--color-on-dark)] hover:bg-[var(--bg-elevated)] hover:border-[var(--color-primary)]/40 transition-all focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            aria-label={t("crisis.refresh")}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* System Status Column */}
        <section className="lg:col-span-1 space-y-6" aria-label="System health">
          <div className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-2xl p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)] mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-[var(--color-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {t("crisis.systemStatus")}
            </h2>
            <div className="space-y-3" role="list">
              {[
                { key: "riskWorker", label: "Risk Worker", status: systemHealth.riskWorker },
                { key: "embeddingModel", label: "Embedding Model", status: systemHealth.embeddingModel },
                { key: "prosodyEngine", label: "Prosody Engine", status: systemHealth.prosodyEngine },
                { key: "database", label: "Database", status: systemHealth.database },
                { key: "api", label: "API", status: systemHealth.api },
              ].map((item) => (
                <StatusIndicator key={item.key} status={item.status} label={item.label} />
              ))}
            </div>
          </div>

          {/* Quick Stats */}
          <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)] mb-4">Quick Stats</h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Active Sessions", value: sessions.length, color: "var(--color-primary)" },
                { label: "Critical", value: sessions.filter(s => s.tier === "red").length, color: "var(--crisis-red)" },
                { label: "Elevated", value: sessions.filter(s => s.tier === "orange").length, color: "var(--crisis-orange)" },
                { label: "Stable", value: sessions.filter(s => s.tier === "green" || s.tier === "yellow").length, color: "var(--crisis-green)" },
              ].map((stat) => (
                <div key={stat.label} className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-xl p-4 text-center group">
                  <div className="font-serif text-3xl font-medium tabular-nums" style={{ color: stat.color }}>
                    {stat.value}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-[var(--color-muted)] mt-1">{stat.label}</div>
                  <div className="mt-2 h-0.5 bg-[var(--border-line)] group-hover:bg-[var(--color-primary)] transition-colors" style={{ transformOrigin: "left", transform: "scaleX(0.3)" }} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Active Sessions Column */}
        <section className="lg:col-span-2 space-y-6" aria-label="Active crisis sessions">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              {t("crisis.activeSessions")}
            </h2>
            <span className="text-xs text-[var(--color-muted)] font-mono tabular-nums">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
          </div>

          {loading ? (
            <div className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-2xl p-6 space-y-4" role="status" aria-live="polite">
              {[...Array(4)].map((_, i) => <SessionCardSkeleton key={i} />)}
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-2xl p-6 max-h-[500px] overflow-y-auto custom-scroll">
              <div className="space-y-3">
                {sessions.map((session) => (
                  <SessionCard key={session.sessionId} session={session} />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* CSI Breakdown Column */}
        <section className="lg:col-span-1 space-y-6" aria-label="CSI signal breakdown">
          <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)] mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-[var(--crisis-amber)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              {t("crisis.csiBreakdown")}
            </h2>

            <div className="space-y-5">
              <SignalBar
                label={t("crisis.s1Signal")}
                value={csiBreakdown.s1 ?? 0}
                color="var(--crisis-amber)"
                description={csiBreakdown.s1 === null ? t("crisis.s1NotEnabled") : undefined}
              />

              <SignalBar
                label={t("crisis.s2Signal")}
                value={csiBreakdown.s2}
                color="var(--crisis-blue)"
                description={t("crisis.s2Score", { score: csiBreakdown.s2 })}
              />

              <SignalBar
                label={t("crisis.s3Signal")}
                value={csiBreakdown.s3 ?? 0}
                color="var(--crisis-purple)"
                description={csiBreakdown.s3 === null ? t("crisis.s3Unavailable") : undefined}
              />

              {/* Composite CSI Score */}
              <div className="pt-4 border-t border-[var(--border-line)]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-medium text-[var(--color-on-dark)]">Composite CSI</span>
                  <span className="font-serif text-2xl font-medium tabular-nums" style={{ color: csiBreakdown.s2 >= 75 ? "var(--crisis-red)" : csiBreakdown.s2 >= 50 ? "var(--crisis-orange)" : csiBreakdown.s2 >= 25 ? "var(--crisis-amber)" : "var(--crisis-green)" }}>
                    {csiBreakdown.s2}
                  </span>
                </div>
                <div className="w-full bg-[var(--border-line)] rounded-full h-3 relative overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{
                      width: `${csiBreakdown.s2}%`,
                      background: csiBreakdown.s2 >= 75 ? "linear-gradient(90deg, var(--crisis-red), var(--crisis-orange))" :
                                 csiBreakdown.s2 >= 50 ? "linear-gradient(90deg, var(--crisis-orange), var(--crisis-amber))" :
                                 csiBreakdown.s2 >= 25 ? "linear-gradient(90deg, var(--crisis-amber), var(--crisis-green))" :
                                 "linear-gradient(90deg, var(--crisis-green), var(--crisis-blue))",
                      boxShadow: csiBreakdown.s2 >= 50 ? "0 0 12px var(--crisis-orange)" : "0 0 8px var(--crisis-green)",
                    }}
                  />
                </div>
                <div className="flex justify-between mt-2 text-xs text-[var(--color-muted)]">
                  <span>Tier 1</span>
                  <span>Tier 2</span>
                  <span>Tier 3</span>
                  <span>Tier 4</span>
                </div>
                <p className="text-xs text-[var(--color-muted)] mt-2 text-center">
                  {csiBreakdown.s2 >= 75 ? t("crisis.tier4") :
                   csiBreakdown.s2 >= 50 ? t("crisis.tier3") :
                   csiBreakdown.s2 >= 25 ? t("crisis.tier2") : t("crisis.tier1")}
                </p>
              </div>

              <div className="mt-4 p-3 bg-[var(--border-line)]/50 rounded-xl text-xs text-[var(--color-muted)]">
                {t("crisis.s1Note")}
              </div>
            </div>
          </div>

          {/* CSI Timeline */}
          <div className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)] mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-[var(--crisis-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v12M5 15h14M5 9h14" />
              </svg>
              {t("crisis.csiTimeline")}
            </h2>
            <div className="space-y-3 max-h-64 overflow-y-auto custom-scroll">
              {turnTimeline.length === 0 ? (
                <div className="text-center py-8 text-[var(--color-muted)]">
                  <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p>No turn data available</p>
                  <p className="text-xs mt-1">Timeline populates as messages are processed</p>
                </div>
              ) : (
                turnTimeline.map((turn) => {
                  const tierColor = turn.csi >= 75 ? "var(--crisis-red)" :
                                    turn.csi >= 50 ? "var(--crisis-orange)" :
                                    turn.csi >= 25 ? "var(--crisis-amber)" : "var(--crisis-green)";
                  return (
                    <div key={turn.turn} className="flex items-center gap-3 text-xs group">
                      <span className="w-10 text-[var(--color-muted)] font-mono tabular-nums">Turn {turn.turn}</span>
                      <div className="flex-1 h-3 bg-[var(--border-line)] rounded-full relative overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500 ease-out"
                          style={{
                            width: `${turn.csi}%`,
                            background: `linear-gradient(90deg, ${tierColor}, color-mix(in srgb, ${tierColor} 70%, white))`,
                          }}
                        />
                      </div>
                      <span className="w-10 text-right font-medium tabular-nums" style={{ color: tierColor }}>
                        {turn.csi}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Footer */}
      <footer className="mt-8 pt-4 border-t border-[var(--border-line)] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[var(--color-muted)]">
        <p>Zenith Crisis Detection System — Anonymous, zero-retention monitoring</p>
        <p className="font-mono">Last updated: {lastUpdate ? lastUpdate.toLocaleTimeString() : "—"}</p>
      </footer>
    </section>
  );
}