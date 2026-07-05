/**
 * Passwordless counsellor auth (TRD §8): email magic link + TOTP MFA.
 * Only the SHA-256 of a link token is stored; tokens are single-use and
 * expire in 15 minutes. Without SMTP configured (dev / small self-host),
 * the magic link is written to the server log for the operator to relay.
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
  // Same outcome whether or not the account exists — no user enumeration.
  const counsellorId: string | undefined = rows[0]?.id;
  if (!counsellorId) return;

  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO login_tokens (token_hash, counsellor_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), counsellorId, LINK_TTL_MINUTES],
  );

  // SMTP adapter slot: when EMAIL_* config exists, send instead of logging.
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
        await client.query("ROLLBACK"); // token stays unused; retry with code
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
