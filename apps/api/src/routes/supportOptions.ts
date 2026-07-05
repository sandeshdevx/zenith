import type { FastifyInstance } from "fastify";

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
    // Becomes true in Phase 5/6 when counsellor routing is live.
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

export function registerSupportOptionsRoute(app: FastifyInstance) {
  app.get("/api/v1/support-options", async () => ({ options: SUPPORT_OPTIONS }));
}
