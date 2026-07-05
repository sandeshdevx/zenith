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

interface ActiveCall {
  sessionId: string;
  roomUrl: string;
}

export default function App() {
  const { t } = useTranslation();
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

  if (stage !== "ready") {
    return (
      <div className="wrap">
        <main className="login">
          <h1>Zenith</h1>
          <p className="tag">{t("login.tagline")}</p>
          {stage === "email" && (
            <>
              <input
                type="email"
                value={email}
                placeholder={t("login.email")}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                disabled={!email.includes("@")}
                onClick={() => {
                  void requestLink(email);
                  setStage("verify");
                }}
              >
                {t("login.sendLink")}
              </button>
            </>
          )}
          {stage === "verify" && (
            <>
              <p className="hint">{t("login.tokenHint")}</p>
              <input
                value={linkToken}
                placeholder={t("login.token")}
                onChange={(e) => setLinkToken(e.target.value)}
              />
              {needsTotp && (
                <input
                  value={totpCode}
                  placeholder={t("login.totp")}
                  inputMode="numeric"
                  onChange={(e) => setTotpCode(e.target.value)}
                />
              )}
              <button disabled={linkToken.length < 10} onClick={() => void login()}>
                {t("login.signIn")}
              </button>
              {error && <p className="error">{error}</p>}
            </>
          )}
        </main>
      </div>
    );
  }

  const visibleAlerts = alerts.filter((a) => !declined.has(a.alertId));

  return (
    <div className="wrap">
      <header className="bar">
        <span className="brand">Zenith · {t("queue.title")}</span>
        <label className="avail">
          <input
            type="checkbox"
            checked={available}
            onChange={(e) => {
              setAvailable(e.target.checked);
              void setAvailability(e.target.checked);
            }}
          />
          {available ? t("queue.available") : t("queue.unavailable")}
        </label>
      </header>

      {calls.length > 0 && (
        <section className="calls">
          {calls.map((c) => (
            <div key={c.sessionId} className="call">
              <span>{t("queue.inSession")} · {c.sessionId.slice(0, 8)}…</span>
              <a href={c.roomUrl} target="_blank" rel="noreferrer">
                {t("queue.rejoin")}
              </a>
              <button onClick={() => setCalls((x) => x.filter((y) => y.sessionId !== c.sessionId))}>
                {t("queue.done")}
              </button>
            </div>
          ))}
        </section>
      )}

      <main className="queue">
        {visibleAlerts.length === 0 && <p className="empty">{t("queue.empty")}</p>}
        {visibleAlerts.map((alert) => (
          <article key={alert.alertId} className={`alert tier-${alert.tier}`}>
            <div className="alert-head">
              <span className="tier">{alert.tier.toUpperCase()}</span>
              <span className="sid">{alert.sessionId.slice(0, 8)}…</span>
              <Countdown until={alert.expiresAt} />
            </div>
            <div className="turns">
              {alert.lastTurns.map((turn, i) => (
                <p key={i} className={`turn turn-${turn.sender}`}>
                  <span>{turn.sender === "user" ? t("queue.them") : t("queue.buddy")}</span>
                  {turn.content}
                </p>
              ))}
            </div>
            <div className="actions">
              <button
                className="accept"
                onClick={() => {
                  void acceptSession(alert.sessionId).then((res) => {
                    if (res) {
                      setCalls((c) => [...c, { sessionId: alert.sessionId, roomUrl: res.roomUrl }]);
                      setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
                      window.open(res.roomUrl, "_blank", "noopener");
                    } else {
                      // someone else won the race — drop it locally
                      setAlerts((a) => a.filter((x) => x.alertId !== alert.alertId));
                    }
                  });
                }}
              >
                {t("queue.accept")}
              </button>
              <button
                className="decline"
                onClick={() => {
                  setDeclined((d) => new Set(d).add(alert.alertId));
                  void declineSession(alert.sessionId);
                }}
              >
                {t("queue.decline")}
              </button>
            </div>
          </article>
        ))}
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
  return <span className="countdown">{m}:{String(s).padStart(2, "0")}</span>;
}
