import { Pool } from "pg";
import type { Config } from "../config.js";

let pool: Pool | undefined;

export function getPool(config: Config): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", () => {
      // Idle-client errors must not crash the process; queries surface their own errors.
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
