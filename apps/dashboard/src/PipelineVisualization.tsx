import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CounsellorServerFrame } from "@zenith/contracts";

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */
type StageId =
  | "message_received"
  | "sentinel_assessing"
  | "sentinel_complete"
  | "embedding_requested"
  | "embedding_received"
  | "s1_semantic_scoring"
  | "s1_complete"
  | "s2_screening"
  | "s2_complete"
  | "s3_prosody"
  | "s3_complete"
  | "fusion"
  | "tiered_response"
  | "alert_raised"
  | "handoff_room_created"
  | "complete";

type StageGroup = "input" | "s1" | "s2" | "s3" | "fusion" | "output";

interface StageDef {
  id: StageId;
  group: StageGroup;
  label: string;
  description: string;
  details?: string[];
}

interface LiveStage {
  status: "idle" | "started" | "completed" | "failed" | "skipped";
  durationMs?: number;
  data?: Record<string, unknown>;
  timestamp: string;
}

const STAGE_DEFS: StageDef[] = [
  { id: "message_received", group: "input", label: "INPUT", description: "User message persisted", details: ["Saved to DB", "Turn count incremented"] },
  { id: "sentinel_assessing", group: "s1", label: "S1", description: "Keyword sentinel scan", details: ["Multi-lang regex", "Fast rule floor"] },
  { id: "sentinel_complete", group: "s1", label: "", description: "Sentinel tier set", details: ["Tier: green/yellow/orange/red"] },
  { id: "embedding_requested", group: "s1", label: "", description: "Request embedding", details: ["Ollama nomic-embed-text"] },
  { id: "embedding_received", group: "s1", label: "", description: "Vector received", details: ["768-dim vector", "Latency tracked"] },
  { id: "s1_semantic_scoring", group: "s1", label: "", description: "Semantic distress (S1)", details: ["Cosine vs prototypes", "Max(sentinel, semantic)"] },
  { id: "s1_complete", group: "s1", label: "", description: "S1 finalized", details: ["S1 score 0–100"] },
  { id: "s2_screening", group: "s2", label: "S2", description: "PHQ-9/GAD-7 screening", details: ["16 clinical items", "Embedding matches"] },
  { id: "s2_complete", group: "s2", label: "", description: "S2 composite scored", details: ["PHQ-9×0.6 + GAD-7×0.4"] },
  { id: "s3_prosody", group: "s3", label: "S3", description: "Acoustic prosody", details: ["F0, rate, pause, energy"] },
  { id: "s3_complete", group: "s3", label: "", description: "Prosody scored", details: ["0–100 or skipped"] },
  { id: "fusion", group: "fusion", label: "FUSION", description: "Weighted fusion", details: ["w1×S1 + w2×S2 + w3×S3", "Turn-adaptive weights"] },
  { id: "tiered_response", group: "fusion", label: "", description: "CSI → Tier mapping", details: ["≥75 red, ≥50 orange, ≥25 yellow"] },
  { id: "alert_raised", group: "output", label: "OUTPUT", description: "Counsellor alert", details: ["Orange/Red only", "10-min TTL"] },
  { id: "handoff_room_created", group: "output", label: "", description: "Jitsi room (Tier 4)", details: ["Pre-created for red"] },
  { id: "complete", group: "output", label: "", description: "Pipeline complete", details: ["Risk stored", "Session updated"] },
];

const GROUP_ORDER: StageGroup[] = ["input", "s1", "s2", "s3", "fusion", "output"];
const GROUP_LABELS: Record<StageGroup, string> = {
  input: "INPUT", s1: "S1", s2: "S2", s3: "S3", fusion: "FUSION", output: "OUTPUT",
};

const GROUP_COLORS: Record<StageGroup, string> = {
  input: "var(--color-primary)",
  s1: "var(--crisis-amber)",
  s2: "var(--crisis-blue)",
  s3: "var(--crisis-purple)",
  fusion: "var(--crisis-orange)",
  output: "var(--crisis-red)",
} as const;

const STATUS_COLORS = {
  idle: "var(--border-line)",
  started: "var(--crisis-amber)",
  completed: "var(--crisis-green)",
  failed: "var(--crisis-red)",
  skipped: "var(--color-dim)",
} as const;

const EMPTY_STAGE: LiveStage = {
  status: "idle",
  timestamp: new Date().toISOString(),
};

const getGroupColor = (group: StageGroup) => GROUP_COLORS[group] ?? "var(--color-primary)";

/* ─────────────────────────────────────────────
   Pipeline Visualization Component
   ───────────────────────────────────────────── */
export default function PipelineVisualization() {
  const { t } = useTranslation();
  const [liveStages, setLiveStages] = useState<Map<StageId, LiveStage>>(new Map());
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [hoveredStage, setHoveredStage] = useState<StageDef | null>(null);
  const [activeFlow, setActiveFlow] = useState<StageId | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const flowTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const getVisual = (stageId: StageId) => {
    const live = liveStages.get(stageId);
    const baseStatus = live?.status ?? "idle";
    const isActive = activeFlow === stageId;
    const status = isActive && baseStatus !== "completed" ? "started" : baseStatus;
    return { ...EMPTY_STAGE, ...live, status, isActive };
  };

  const handleReconnect = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    const apiBase = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    const ws = new WebSocket(`${apiBase}/api/v1/counsellor/ws`);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onmessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(event.data as string) as CounsellorServerFrame;
        if (frame.type === "pipeline.stage") {
          setLiveStages((prev) => {
            const next = new Map(prev);
            next.set(frame.stage as StageId, {
              status: frame.status,
              durationMs: frame.durationMs,
              data: frame.data,
              timestamp: frame.timestamp,
            });
            return next;
          });
          setCurrentSessionId(frame.sessionId);
          setActiveFlow(frame.stage as StageId);
          if (flowTimeoutRef.current) clearTimeout(flowTimeoutRef.current);
          flowTimeoutRef.current = setTimeout(() => setActiveFlow(null), 800);
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.onclose = () => {
      setWsConnected(false);
      setTimeout(handleReconnect, 3000);
    };
  }, []);

  useEffect(() => {
    handleReconnect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (flowTimeoutRef.current) clearTimeout(flowTimeoutRef.current);
    };
  }, [handleReconnect]);

  return (
    <section
      className="bg-[var(--bg-dark)] border border-[var(--border-line)] rounded-2xl p-8 overflow-x-hidden"
      aria-labelledby="pipeline-title"
      aria-live="polite"
    >
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-[var(--crisis-orange)]/10 flex items-center justify-center" aria-hidden="true">
            <svg className="w-5 h-5 text-[var(--crisis-orange)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h2 id="pipeline-title" className="font-serif text-xl font-normal text-[var(--color-on-dark)] tracking-tight">
              {t("pipeline.title")}
            </h2>
            <p className="text-sm text-[var(--color-dim)] mt-1">Live crisis detection pipeline</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`w-2.5 h-2.5 rounded-full ${wsConnected ? "bg-[var(--crisis-green)] animate-pulse" : "bg-[var(--crisis-red)]"}`}
            aria-label={wsConnected ? "WebSocket connected" : "WebSocket disconnected"}
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-[var(--color-dim)] tabular-nums">
            {wsConnected ? "LIVE" : "OFFLINE"}
          </span>
          {currentSessionId && (
            <span className="text-xs font-mono text-[var(--color-muted)] px-2 py-0.5 bg-[var(--bg-dark-up)] rounded">
              #{currentSessionId.slice(0, 8)}…
            </span>
          )}
        </div>
      </header>

      {/* Pipeline Flow */}
      <div className="relative" role="list" aria-label="Pipeline stages">
        {/* Group labels row - scrolls with stages */}
        <div className="flex items-end gap-1 mb-4 overflow-x-auto pb-2 scrollbar-hide" aria-hidden="true" style={{ scrollSnapType: "x mandatory" }}>
          {GROUP_ORDER.map((group) => {
            const groupStages = STAGE_DEFS.filter((s) => s.group === group);
            const groupWidth = groupStages.length * 80 + (groupStages.length - 1) * 16;
            return (
              <div key={group} className="flex-shrink-0 snap-start" style={{ width: groupWidth }}>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-center text-[var(--color-muted)]" style={{ color: getGroupColor(group) }}>
                  {GROUP_LABELS[group]}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pipeline stages row */}
        <div className="flex items-start gap-4 overflow-x-auto pb-4 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
          {STAGE_DEFS.map((stage, idx) => {
            const visual = getVisual(stage.id) as LiveStage & { isActive: boolean };
            const showLabel = stage.label !== "";
            const groupColor = getGroupColor(stage.group);
            const nextStage = STAGE_DEFS[idx + 1];
            const prevStage = STAGE_DEFS[idx - 1];

            return (
              <article
                key={stage.id}
                className="flex-shrink-0 flex flex-col items-center group relative snap-start"
                style={{ width: 80 }}
                onMouseEnter={() => setHoveredStage(stage)}
                onMouseLeave={() => setHoveredStage(null)}
              >
                {/* Connector within group */}
                {idx < STAGE_DEFS.length - 1 && nextStage?.group === stage.group && (
                  <div className="absolute left-full top-10 w-4 h-0.5 -ml-4" aria-hidden="true">
                    <div className="h-full w-full bg-[var(--border-line)] relative overflow-hidden">
                      <div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-flow"
                        style={{
                          animationDuration: "2s",
                          opacity: visual.status === "completed" ? 1 : 0,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Group separator */}
                {idx < STAGE_DEFS.length - 1 && nextStage?.group !== stage.group && (
                  <div className="absolute left-full top-10 w-4 h-0.5 -ml-4 opacity-20" aria-hidden="true">
                    <div className="h-full w-full bg-[var(--border-line)]" />
                  </div>
                )}

                {/* Stage Circle */}
                <button
                  type="button"
                  className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-dark)]"
                  style={{
                    border: `2px solid ${STATUS_COLORS[visual.status]}`,
                    background:
                      visual.status === "completed"
                        ? STATUS_COLORS.completed
                        : visual.status === "started" || visual.isActive
                        ? `color-mix(in srgb, ${STATUS_COLORS.started} 15%, transparent)`
                        : visual.status === "failed"
                        ? `color-mix(in srgb, ${STATUS_COLORS.failed} 15%, transparent)`
                        : "transparent",
                    color: STATUS_COLORS[visual.status],
                    boxShadow:
                      visual.isActive
                        ? `0 0 0 3px ${STATUS_COLORS.started}40, 0 0 20px ${STATUS_COLORS.started}50`
                        : visual.status === "completed"
                        ? `0 0 0 2px ${STATUS_COLORS.completed}40`
                        : "none",
                    animation: visual.isActive ? "pulse-ring 1.2s ease-out infinite" : "none",
                  }}
                  aria-label={`${stage.label || GROUP_LABELS[stage.group]}: ${visual.status}`}
                  aria-disabled={visual.status === "idle"}
                  onClick={() => setHoveredStage(stage)}
                >
                  {visual.status === "completed" && (
                    <svg className="w-8 h-8 text-[var(--color-on-dark)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {(visual.status === "started" || visual.isActive) && (
                    <svg className="w-8 h-8 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="text-current opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="text-current" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  {visual.status === "failed" && (
                    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  {visual.status === "skipped" && (
                    <svg className="w-6 h-6 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  )}
                  {visual.status === "idle" && !visual.isActive && (
                    <div className="w-4 h-4 rounded-full bg-[var(--border-line)]" aria-hidden="true" />
                  )}
                </button>

                {/* Duration badge */}
                {visual.durationMs && visual.status === "completed" && (
                  <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[9px] font-mono text-[var(--color-muted)] whitespace-nowrap bg-[var(--bg-dark-up)] px-1.5 py-0.5 rounded">
                    {visual.durationMs}ms
                  </div>
                )}

                {/* Stage Label */}
                {showLabel && (
                  <div className="mt-3 text-center">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-on-dark)]" style={{ color: groupColor }}>
                      {stage.label}
                    </span>
                  </div>
                )}

                {/* Sub-stage indicator dots */}
                {!showLabel && idx > 0 && prevStage?.group === stage.group && (
                  <div className="mt-3 flex gap-1.5" aria-hidden="true">
                    <div className="w-2 h-2 rounded-full" style={{ background: groupColor }} />
                    <div className="w-2 h-2 rounded-full" style={{ background: `color-mix(in srgb, ${groupColor} 45%, transparent)` }} />
                    <div className="w-2 h-2 rounded-full" style={{ background: `color-mix(in srgb, ${groupColor} 20%, transparent)` }} />
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {/* Global flow sweep */}
        <div className="absolute top-12 left-0 right-0 h-0.5 pointer-events-none overflow-hidden" aria-hidden="true">
          <div
            className="h-full bg-gradient-to-r from-transparent via-[var(--crisis-orange)] to-transparent animate-flow"
            style={{ opacity: activeFlow ? 1 : 0 }}
          />
        </div>

        {/* Hover/Focus Tooltip */}
        {hoveredStage && (
          <div
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 w-96 p-5 bg-[var(--bg-dark-up)] border border-[var(--border-line)] rounded-xl shadow-2xl z-30 animate-pipeline-fade-in"
            role="tooltip"
          >
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: getGroupColor(hoveredStage.group) }} aria-hidden="true" />
              <span className="font-medium text-[var(--color-on-dark)] text-sm">{hoveredStage.label || GROUP_LABELS[hoveredStage.group]}</span>
              <span className="text-[10px] text-[var(--color-muted)]">({hoveredStage.group})</span>
            </div>
            <p className="text-sm text-[var(--color-dim)] mb-4">{hoveredStage.description}</p>
            {hoveredStage.details && (
              <ul className="text-[11px] text-[var(--color-muted)] space-y-1.5 mb-4">
                {hoveredStage.details.map((d, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: getGroupColor(hoveredStage.group) }} aria-hidden="true" />
                    {d}
                  </li>
                ))}
              </ul>
            )}
            <div className="pt-3 border-t border-[var(--border-line)] text-[11px] flex items-center justify-between">
              <span className="text-[var(--color-muted)]">Status</span>
              <span className="font-medium capitalize" style={{ color: STATUS_COLORS[getVisual(hoveredStage.id).status] }}>
                {getVisual(hoveredStage.id).status}
              </span>
            </div>
            {getVisual(hoveredStage.id).durationMs && (
              <div className="flex items-center justify-between mt-2 text-[11px]">
                <span className="text-[var(--color-muted)]">Duration</span>
                <span className="font-mono text-[var(--color-on-dark)]">{getVisual(hoveredStage.id).durationMs}ms</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <footer className="mt-8 pt-6 border-t border-[var(--border-line)] flex flex-wrap items-center justify-center gap-6 text-[10px] text-[var(--color-muted)]">
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-[var(--crisis-green)]" aria-hidden="true" /><span>Completed</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-[var(--crisis-amber)] animate-pulse" aria-hidden="true" /><span>Running</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-[var(--crisis-red)]" aria-hidden="true" /><span>Failed</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full border border-[var(--color-dim)]" aria-hidden="true" /><span>Skipped</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full border border-[var(--border-line)]" aria-hidden="true" /><span>Pending</span></div>
      </footer>
    </section>
  );
}