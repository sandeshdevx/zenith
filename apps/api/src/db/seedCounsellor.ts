/**
 * Operator CLI: create a counsellor account.
 * Usage: npm run seed:counsellor -w @zenith/api -- <email> <display name...>
 */
import { Pool } from "pg";
import { loadConfig } from "../config.js";

const [email, ...nameParts] = process.argv.slice(2);
const displayName = nameParts.join(" ");

if (!email || !displayName) {
  console.error("Usage: npm run seed:counsellor -w @zenith/api -- <email> <display name>");
  process.exit(1);
}

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });

pool
  .query(
    `INSERT INTO counsellors (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET display_name = $2, is_active = true
     RETURNING id`,
    [email.toLowerCase().trim(), displayName],
  )
  .then(({ rows }) => {
    console.log(`counsellor ready: ${email} (${rows[0].id})`);
    return pool.end();
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
