import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://zenith:zenith@localhost:5432/zenith' });

const { rows } = await pool.query("SELECT * FROM risk_assessments WHERE session_id = '2d8df156-1bc9-4d8a-a70e-1ff65e151ff7' ORDER BY id DESC");
console.log('Risk assessments for my session:', JSON.stringify(rows, null, 2));

const { rows: alerts } = await pool.query("SELECT * FROM alerts ORDER BY id DESC LIMIT 5");
console.log('Alerts:', JSON.stringify(alerts, null, 2));

await pool.end();