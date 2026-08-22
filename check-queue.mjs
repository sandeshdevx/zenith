import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://zenith:zenith@localhost:5432/zenith' });

// Check pg-boss job table
const { rows } = await pool.query("SELECT * FROM pgboss.job WHERE name = 'score_message' ORDER BY created_on DESC LIMIT 10");
console.log('Jobs in pgboss.job:', JSON.stringify(rows, null, 2));

// Check if worker is actually running by checking session_messages
const { rows: messages } = await pool.query("SELECT * FROM session_messages WHERE session_id = '2d8df156-1bc9-4d8a-a70e-1ff65e151ff7' ORDER BY id");
console.log('Messages for my session:', JSON.stringify(messages, null, 2));

await pool.end();