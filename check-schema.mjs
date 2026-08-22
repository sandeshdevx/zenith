import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://zenith:zenith@localhost:5432/zenith' });

// Check pg-boss job table
const { rows: cols } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'pgboss' AND table_name = 'job'");
console.log('Columns:', cols);

await pool.end();