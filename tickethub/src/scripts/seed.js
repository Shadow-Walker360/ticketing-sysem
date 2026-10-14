import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';

const { rows } = await pool.query('SELECT count(*) AS count FROM events');
if (rows[0].count > 0) {
  console.log('Database already has events; skipping seed.');
  await pool.end();
  process.exit(0);
}

const SEATS_SQL = `
  INSERT INTO seats (event_id, section, row_label, seat_number, price_cents)
  SELECT $1::int, sec.section, chr(64 + r.n), s.n, sec.price
    FROM (VALUES ('A', 10000), ('B', 6000)) AS sec(section, price)
   CROSS JOIN generate_series(1, 5) AS r(n)
   CROSS JOIN generate_series(1, 10) AS s(n)`;

await withTransaction(async (db) => {
  const events = [
    ['Nairobi Afrobeats Night', 'KICC Grounds, Nairobi', "now() + interval '30 days'", "now() - interval '1 day'"],
    ['Eldoret Gospel Festival', 'Eldoret Sports Club', "now() + interval '45 days'", "now() + interval '7 days'"],
  ];
  for (const [title, venue, startsAt, onSaleAt] of events) {
    const { rows: created } = await db.query(
      `INSERT INTO events (title, venue, starts_at, on_sale_at)
       VALUES ($1, $2, ${startsAt}, ${onSaleAt}) RETURNING id`,
      [title, venue],
    );
    await db.query(SEATS_SQL, [created[0].id]);
  }
  await db.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)',
    ['demo@tickethub.test', await bcrypt.hash('demo-password', 10), 'Demo User'],
  );
});

console.log('Seeded 2 events (100 seats each) and demo@tickethub.test / demo-password (development only).');
await pool.end();
