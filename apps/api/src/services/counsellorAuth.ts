/**
 * Counsellor auth — two modes:
 *   1. Magic link (legacy, kept for operator relay / dev)
 *   2. Direct TOTP login (email + 6-digit TOTP code, no email step)
 *
 * Only SHA-256 of link tokens is stored; tokens are single-use / 15-min TTL.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";

const LINK_TTL_MINUTES = 15;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestMagicLink(
  pool: Pool,
  log: FastifyBaseLogger,
  email: string,
): Promise<void> {
  const { rows } = await pool.query(
    "SELECT id FROM counsellors WHERE email = $1 AND is_active",
    [email.toLowerCase().trim()],
  );
  const counsellorId: string | undefined = rows[0]?.id;
  if (!counsellorId) return;

  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO login_tokens (token_hash, counsellor_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), counsellorId, LINK_TTL_MINUTES],
  );

  log.info({ email }, `magic-link token (deliver to counsellor): ${token}`);
}

export interface VerifiedLogin {
  counsellorId: string;
  role: "counsellor" | "supervisor" | "admin";
  totpRequired: boolean;
}

/** Consumes the link token; totpCode must be present when MFA is enrolled. */
export async function verifyMagicLink(
  pool: Pool,
  token: string,
  totpCode: string | undefined,
  verifyTotp: (code: string, secret: string) => boolean,
): Promise<VerifiedLogin | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE login_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING counsellor_id`,
      [hashToken(token)],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const counsellor = await client.query(
      "SELECT id, role, totp_secret FROM counsellors WHERE id = $1 AND is_active",
      [rows[0].counsellor_id],
    );
    const row = counsellor.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.totp_secret) {
      if (!totpCode || !verifyTotp(totpCode, row.totp_secret)) {
        await client.query("ROLLBACK");
        return { counsellorId: row.id, role: row.role, totpRequired: true };
      }
    }
    await client.query("COMMIT");
    return { counsellorId: row.id, role: row.role, totpRequired: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Direct TOTP login — counsellor provides email + TOTP code, no magic link.
 * Returns null if credentials are invalid or TOTP fails.
 * Returns { totpRequired: true } if the account has no TOTP enrolled yet
 * (operator must enroll them first via /totp/enroll).
 */
export async function loginDirectTotp(
  pool: Pool,
  email: string,
  totpCode: string,
  verifyTotp: (code: string, secret: string) => boolean,
): Promise<VerifiedLogin | null> {
  const { rows } = await pool.query(
    "SELECT id, role, totp_secret FROM counsellors WHERE email = $1 AND is_active",
    [email.toLowerCase().trim()],
  );
  const row = rows[0];
  // Constant-time-ish: always check even if no row to prevent user enumeration
  if (!row || !row.totp_secret) return null;
  if (!verifyTotp(totpCode, row.totp_secret)) return null;
  return { counsellorId: row.id, role: row.role, totpRequired: false };
}
