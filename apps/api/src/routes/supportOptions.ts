import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

/**
 * Human support registry (PRD Flow C + fallback helplines).
 * Static and data-driven so regional helplines can be added by the
 * open-source community without code changes. Labels are i18n keys —
 * translation happens client-side via i18next.
 */
const SUPPORT_OPTIONS = [
  {
    id: "volunteer",
    kind: "video" as const,
    labelKey: "support.volunteer",
    // Availability resolved live from counsellor presence at request time.
    available: false,
  },
  {
    id: "icall",
    kind: "phone" as const,
    labelKey: "support.icall",
    phone: "+91-9152987821",
    hours: "Mon–Sat, 10:00–20:00 IST",
    language: ["en", "hi"],
    available: true,
  },
  {
    id: "vandrevala",
    kind: "phone" as const,
    labelKey: "support.vandrevala",
    phone: "+91-9999666555",
    hours: "24x7",
    language: ["en", "hi"],
    available: true,
  },
  // No-SIM paths: work on WiFi-only devices — no phone number, no SIM,
  // no account beyond what the destination service itself requires.
  {
    id: "vandrevala-whatsapp",
    kind: "link" as const,
    labelKey: "support.vandrevalaWhatsapp",
    url: "https://wa.me/919999666555",
    hours: "24x7",
    language: ["en", "hi"],
    available: true,
  },
  {
    id: "icall-chat",
    kind: "link" as const,
    labelKey: "support.icallChat",
    url: "https://icallhelpline.org/",
    hours: "Mon–Sat, 10:00–20:00 IST",
    language: ["en", "hi"],
    available: true,
  },
  {
    id: "aasra",
    kind: "phone" as const,
    labelKey: "support.aasra",
    phone: "+91-9820466726",
    hours: "24x7",
    language: ["en", "hi"],
    available: true,
  },
  {
    id: "sevencups",
    kind: "link" as const,
    labelKey: "support.sevencups",
    url: "https://www.7cups.com/talk-to-someone-now/",
    language: ["en"],
    available: true,
  },
];

export function registerSupportOptionsRoute(app: FastifyInstance, pool: Pool) {
  app.get("/api/v1/support-options", async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM counsellor_availability
       WHERE is_available AND last_seen_at > now() - interval '2 minutes'
       LIMIT 1`,
    );
    const volunteerOnline = rows.length > 0;
    return {
      options: SUPPORT_OPTIONS.map((o) =>
        o.id === "volunteer" ? { ...o, available: volunteerOnline } : o,
      ),
    };
  });
}
