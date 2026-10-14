import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The tests wipe every table, so they only ever run against a database whose name ends in _test.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://tickethub:tickethub@localhost:5432/tickethub_test';
if (!/_test$/.test(new URL(testDatabaseUrl).pathname)) {
  throw new Error('TEST_DATABASE_URL must point to a database whose name ends in "_test"');
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { signToken } = await import('../src/auth.js');
const { releaseExpiredHolds } = await import('../src/jobs/expireHolds.js');

let server;
let baseUrl;
let userCounter = 0;

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createUser() {
  userCounter += 1;
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [`user${userCounter}@example.com`, 'unused-hash', `User ${userCounter}`],
  );
  return { id: rows[0].id, token: signToken(rows[0].id) };
}

async function createEvent({ seats = 10, onSaleOffset = '-1 hour' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO events (title, venue, starts_at, on_sale_at)
     VALUES ('Test Concert', 'Test Arena', now() + interval '30 days', now() + $1::interval)
     RETURNING id`,
    [onSaleOffset],
  );
  const eventId = rows[0].id;
  await pool.query(
    `INSERT INTO seats (event_id, section, row_label, seat_number, price_cents)
     SELECT $1::int, 'A', 'A', n, 5000 FROM generate_series(1, $2::int) AS n`,
    [eventId, seats],
  );
  const { rows: seatRows } = await pool.query('SELECT id FROM seats WHERE event_id = $1 ORDER BY id', [eventId]);
  return { eventId, seatIds: seatRows.map((row) => row.id) };
}

let keyCounter = 0;
const nextKey = () => `key-${Date.now()}-${(keyCounter += 1)}-padding`;

const hold = (user, eventId, seatIds, idempotencyKey = nextKey()) =>
  api('POST', '/orders', { token: user.token, body: { eventId, seatIds, idempotencyKey } });

const pay = (user, orderId, paymentToken = 'tok_visa', idempotencyKey = nextKey()) =>
  api('POST', `/orders/${orderId}/payments`, { token: user.token, body: { paymentToken, idempotencyKey } });

async function seatState(seatId) {
  const { rows } = await pool.query('SELECT status, order_id FROM seats WHERE id = $1', [seatId]);
  return rows[0];
}

before(async () => {
  await pool.query(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  server = createApp({ seatMapTtlMs: 0, rateLimitPerMinute: 1_000_000 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE payments, seats, orders, events, users RESTART IDENTITY CASCADE');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('buying a ticket', () => {
  it('registers, logs in, browses, holds, pays and lists tickets', async () => {
    const { eventId } = await createEvent({ seats: 5 });

    const registered = await api('POST', '/auth/register', {
      body: { email: 'Joshua@Example.com', name: 'Joshua', password: 'correct-horse' },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.email, 'joshua@example.com');

    const duplicate = await api('POST', '/auth/register', {
      body: { email: 'joshua@example.com', name: 'Joshua', password: 'correct-horse' },
    });
    assert.equal(duplicate.status, 409);

    const badLogin = await api('POST', '/auth/login', {
      body: { email: 'joshua@example.com', password: 'wrong-password' },
    });
    assert.equal(badLogin.status, 401);

    const login = await api('POST', '/auth/login', {
      body: { email: 'joshua@example.com', password: 'correct-horse' },
    });
    assert.equal(login.status, 200);
    const user = { token: login.body.token };

    const events = await api('GET', '/events?query=test%20conc');
    assert.equal(events.body.events.length, 1);
    assert.equal((await api('GET', `/events/${eventId}`)).status, 200);
    assert.equal((await api('GET', '/events/9999')).status, 404);

    const seatMap = await api('GET', `/events/${eventId}/seats`);
    assert.equal(seatMap.body.seats.length, 5);
    assert.ok(seatMap.body.seats.every((seat) => seat.status === 'AVAILABLE'));
    const [first, second] = seatMap.body.seats;

    const held = await hold(user, eventId, [first.id, second.id]);
    assert.equal(held.status, 201);
    assert.equal(held.body.status, 'PENDING');
    assert.equal(held.body.totalCents, 10_000);

    const afterHold = await api('GET', `/events/${eventId}/seats`);
    assert.equal(afterHold.body.seats.filter((seat) => seat.status === 'HELD').length, 2);

    const paid = await pay(user, held.body.orderId);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.status, 'PAID');
    assert.deepEqual(paid.body.tickets.map((t) => t.seatId), [first.id, second.id]);

    const tickets = await api('GET', '/users/me/tickets', { token: user.token });
    assert.equal(tickets.body.tickets.length, 2);
    assert.equal(tickets.body.tickets[0].event.title, 'Test Concert');

    const order = await api('GET', `/orders/${held.body.orderId}`, { token: user.token });
    assert.equal(order.body.status, 'PAID');
  });

  it('requires authentication and protects other users orders', async () => {
    const { eventId, seatIds } = await createEvent();
    const owner = await createUser();
    const stranger = await createUser();
    const held = await hold(owner, eventId, [seatIds[0]]);

    assert.equal((await api('POST', '/orders', { body: {} })).status, 401);
    assert.equal((await api('GET', `/orders/${held.body.orderId}`, { token: stranger.token })).status, 403);
    assert.equal((await pay(stranger, held.body.orderId)).status, 403);
    assert.equal((await api('DELETE', `/orders/${held.body.orderId}`, { token: stranger.token })).status, 403);
    assert.equal((await api('GET', '/orders/9999', { token: owner.token })).status, 404);
  });

  it('rejects invalid requests', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 8 });
    const other = await createEvent({ seats: 2 });
    const user = await createUser();

    assert.equal((await hold(user, eventId, [])).status, 400);
    assert.equal((await hold(user, eventId, ['abc'])).status, 400);
    assert.equal((await hold(user, 'x', [seatIds[0]])).status, 400);
    assert.equal((await hold(user, eventId, seatIds.slice(0, 5))).status, 422, 'more than 4 seats');
    assert.equal((await hold(user, eventId, [seatIds[0], seatIds[0]])).status, 422, 'duplicate seats');
    assert.equal((await hold(user, eventId, [other.seatIds[0]])).status, 422, 'seat from another event');
    assert.equal((await hold(user, eventId, [999_999])).status, 422, 'unknown seat');
    assert.equal((await hold(user, 999_999, [seatIds[0]])).status, 404, 'unknown event');
    assert.equal((await api('POST', '/orders', { token: user.token, body: { eventId, seatIds: [seatIds[0]] } })).status, 400, 'missing idempotency key');
  });

  it('does not allow holds before the sale opens', async () => {
    const { eventId, seatIds } = await createEvent({ onSaleOffset: '+1 day' });
    const user = await createUser();
    const response = await hold(user, eventId, [seatIds[0]]);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'NOT_ON_SALE');
  });

  it('limits a user to 4 seats per event across orders', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 8 });
    const user = await createUser();
    assert.equal((await hold(user, eventId, seatIds.slice(0, 3))).status, 201);
    const tooMany = await hold(user, eventId, seatIds.slice(3, 5));
    assert.equal(tooMany.status, 422);
    assert.equal(tooMany.body.error.code, 'SEAT_LIMIT');
    assert.equal((await hold(user, eventId, [seatIds[3]])).status, 201);
  });
});

describe('preventing double-booking', () => {
  it('lets exactly one of 150 simultaneous buyers hold the same seat', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 1 });
    const users = await Promise.all(Array.from({ length: 150 }, createUser));

    const responses = await Promise.all(users.map((user) => hold(user, eventId, [seatIds[0]])));

    const winners = responses.filter((r) => r.status === 201);
    const losers = responses.filter((r) => r.status === 409);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 149);
    assert.equal(responses.length, winners.length + losers.length, 'no other status codes');

    const seat = await seatState(seatIds[0]);
    assert.equal(seat.status, 'HELD');
    assert.equal(seat.order_id, winners[0].body.orderId);
  });

  it('handles overlapping multi-seat requests without deadlocks or double holds', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 20 });
    const users = await Promise.all(Array.from({ length: 100 }, createUser));

    // Each user wants 2 random seats, listed in random order, so requests overlap heavily.
    const responses = await Promise.all(
      users.map((user, index) => {
        const pick = [...seatIds].sort(() => Math.random() - 0.5).slice(0, 2);
        return hold(user, eventId, pick, `overlap-${index}-padding`);
      }),
    );

    assert.ok(responses.every((r) => r.status === 201 || r.status === 409), 'only 201 or 409 expected');
    const winners = responses.filter((r) => r.status === 201);
    assert.ok(winners.length >= 1 && winners.length <= 10);

    const { rows: held } = await pool.query(
      `SELECT order_id, count(*)::int AS seats FROM seats WHERE status = 'HELD' GROUP BY order_id`,
    );
    assert.equal(held.length, winners.length, 'every held seat belongs to a winning order');
    assert.ok(held.every((row) => row.seats === 2), 'winning orders hold all of their seats');
    const heldSeatIds = winners.flatMap((r) => r.body.seatIds);
    assert.equal(new Set(heldSeatIds).size, heldSeatIds.length, 'no seat appears in two orders');
  });

  it('sells every seat exactly once in a simulated sale of 40 seats and 120 buyers', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 40 });
    const users = await Promise.all(Array.from({ length: 120 }, createUser));

    const outcomes = await Promise.all(
      users.map(async (user) => {
        const wanted = seatIds[Math.floor(Math.random() * seatIds.length)];
        const held = await hold(user, eventId, [wanted]);
        if (held.status !== 201) return { held: false, status: held.status };
        const paid = await pay(user, held.body.orderId);
        return { held: true, status: paid.status, seatId: wanted };
      }),
    );

    assert.ok(outcomes.every((o) => (o.held ? o.status === 201 : o.status === 409)));
    const soldSeatIds = outcomes.filter((o) => o.held).map((o) => o.seatId);
    assert.equal(new Set(soldSeatIds).size, soldSeatIds.length, 'no seat sold twice');

    const { rows } = await pool.query(`SELECT count(*)::int AS sold FROM seats WHERE status = 'SOLD'`);
    assert.equal(rows[0].sold, soldSeatIds.length);
    const { rows: payments } = await pool.query(`SELECT count(*)::int AS count FROM payments WHERE status = 'SUCCEEDED'`);
    assert.equal(payments[0].count, soldSeatIds.length, 'exactly one successful payment per sold seat');
  });

  it('is all-or-nothing: a request containing a taken seat holds nothing', async () => {
    const { eventId, seatIds } = await createEvent();
    const first = await createUser();
    const second = await createUser();
    assert.equal((await hold(first, eventId, [seatIds[0]])).status, 201);

    const response = await hold(second, eventId, [seatIds[1], seatIds[0]]);
    assert.equal(response.status, 409);
    assert.equal((await seatState(seatIds[1])).status, 'AVAILABLE');
  });

  it('is rejected by the database itself if a seat is marked SOLD without an order', async () => {
    const { seatIds } = await createEvent({ seats: 1 });
    await assert.rejects(
      pool.query(`UPDATE seats SET status = 'SOLD' WHERE id = $1`, [seatIds[0]]),
      (error) => error.code === '23514',
    );
  });
});

describe('idempotency', () => {
  it('returns the same order when a hold request is repeated', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const key = 'retry-this-request-001';

    const first = await hold(user, eventId, [seatIds[0]], key);
    const repeat = await hold(user, eventId, [seatIds[0]], key);
    assert.equal(first.status, 201);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.orderId, first.body.orderId);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM orders');
    assert.equal(rows[0].count, 1);
  });

  it('creates one order even when the same request is sent 10 times at once', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => hold(user, eventId, [seatIds[0]], 'double-click-key-001')),
    );
    assert.ok(responses.every((r) => r.status === 201 || r.status === 200));
    assert.equal(new Set(responses.map((r) => r.body.orderId)).size, 1);
  });

  it('charges once when a payment request is repeated', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const held = await hold(user, eventId, [seatIds[0]]);
    const key = 'pay-once-please-001';

    const first = await pay(user, held.body.orderId, 'tok_visa', key);
    const repeat = await pay(user, held.body.orderId, 'tok_visa', key);
    assert.equal(first.status, 201);
    assert.equal(repeat.status, 200);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM payments');
    assert.equal(rows[0].count, 1);

    const other = await pay(user, held.body.orderId, 'tok_visa', 'a-different-key-001');
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'ALREADY_PAID');
  });
});

describe('payments', () => {
  it('keeps the hold after a declined card and lets the user retry', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const held = await hold(user, eventId, [seatIds[0]]);

    const declined = await pay(user, held.body.orderId, 'tok_decline');
    assert.equal(declined.status, 402);
    assert.equal((await seatState(seatIds[0])).status, 'HELD');

    const retry = await pay(user, held.body.orderId, 'tok_visa');
    assert.equal(retry.status, 201);
    assert.equal((await seatState(seatIds[0])).status, 'SOLD');
  });

  it('rejects an invalid payment token without selling the seat', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const held = await hold(user, eventId, [seatIds[0]]);
    assert.equal((await pay(user, held.body.orderId, 'not-a-token')).status, 402);
    assert.equal((await seatState(seatIds[0])).status, 'HELD');
  });
});

describe('expiry and cancellation', () => {
  it('releases expired holds, lets someone else buy, and never charges the late payer', async () => {
    const { eventId, seatIds } = await createEvent();
    const slow = await createUser();
    const quick = await createUser();
    const held = await hold(slow, eventId, [seatIds[0]]);

    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second'`);
    await pool.query(`UPDATE seats SET hold_expires_at = now() - interval '1 second' WHERE status = 'HELD'`);

    const shown = await api('GET', `/orders/${held.body.orderId}`, { token: slow.token });
    assert.equal(shown.body.status, 'EXPIRED');

    const takeover = await hold(quick, eventId, [seatIds[0]]);
    assert.equal(takeover.status, 201, 'an expired hold does not block a new buyer');

    const late = await pay(slow, held.body.orderId);
    assert.equal(late.status, 410);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM payments');
    assert.equal(rows[0].count, 0, 'the late payer was not charged');

    assert.equal((await pay(quick, takeover.body.orderId)).status, 201);
    assert.equal((await seatState(seatIds[0])).order_id, takeover.body.orderId);
  });

  it('background worker returns expired seats to sale', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const held = await hold(user, eventId, seatIds.slice(0, 2));
    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second'`);
    await pool.query(`UPDATE seats SET hold_expires_at = now() - interval '1 second' WHERE status = 'HELD'`);

    assert.equal(await releaseExpiredHolds(), 1);
    assert.equal(await releaseExpiredHolds(), 0, 'nothing left to release');
    assert.equal((await seatState(seatIds[0])).status, 'AVAILABLE');
    const order = await api('GET', `/orders/${held.body.orderId}`, { token: user.token });
    assert.equal(order.body.status, 'EXPIRED');
    assert.deepEqual(order.body.seatIds, []);
  });

  it('does not expire an order that is paid at the same moment as the worker runs', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const held = await hold(user, eventId, [seatIds[0]]);
    await pool.query(`UPDATE orders SET expires_at = now() + interval '1 second'`);
    await pool.query(`UPDATE seats SET hold_expires_at = now() + interval '1 second' WHERE status = 'HELD'`);

    const [payment] = await Promise.all([pay(user, held.body.orderId), releaseExpiredHolds()]);
    assert.equal(payment.status, 201);
    assert.equal((await seatState(seatIds[0])).status, 'SOLD');
  });

  it('cancels a pending order and frees its seats, but refuses to cancel a paid one', async () => {
    const { eventId, seatIds } = await createEvent();
    const user = await createUser();
    const pending = await hold(user, eventId, [seatIds[0]]);
    assert.equal((await api('DELETE', `/orders/${pending.body.orderId}`, { token: user.token })).status, 204);
    assert.equal((await seatState(seatIds[0])).status, 'AVAILABLE');
    assert.equal((await api('DELETE', `/orders/${pending.body.orderId}`, { token: user.token })).status, 204, 'repeat is harmless');

    const bought = await hold(user, eventId, [seatIds[1]]);
    await pay(user, bought.body.orderId);
    const refusal = await api('DELETE', `/orders/${bought.body.orderId}`, { token: user.token });
    assert.equal(refusal.status, 409);
    assert.equal((await seatState(seatIds[1])).status, 'SOLD');
  });
});

describe('seat map cache and limits', () => {
  it('serves a cached seat map within the TTL and shares one query between concurrent readers', async () => {
    const { eventId, seatIds } = await createEvent({ seats: 3 });
    const cachedServer = createApp({ seatMapTtlMs: 60_000, rateLimitPerMinute: 1_000_000 }).listen(0);
    await new Promise((resolve) => cachedServer.once('listening', resolve));
    const url = `http://127.0.0.1:${cachedServer.address().port}/events/${eventId}/seats`;
    try {
      const reads = await Promise.all(Array.from({ length: 50 }, () => fetch(url).then((r) => r.json())));
      assert.ok(reads.every((r) => r.seats.length === 3));

      await pool.query('UPDATE seats SET price_cents = 1 WHERE id = $1', [seatIds[0]]);
      const again = await (await fetch(url)).json();
      assert.equal(again.seats[0].priceCents, 5000, 'still the cached copy');
    } finally {
      await new Promise((resolve) => cachedServer.close(resolve));
    }
  });

  it('answers 429 when a client exceeds the rate limit', async () => {
    const limited = createApp({ rateLimitPerMinute: 3 }).listen(0);
    await new Promise((resolve) => limited.once('listening', resolve));
    const url = `http://127.0.0.1:${limited.address().port}/health`;
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    } finally {
      await new Promise((resolve) => limited.close(resolve));
    }
  });

  it('returns JSON errors for unknown routes and malformed bodies', async () => {
    assert.equal((await api('GET', '/nope')).status, 404);
    const bad = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_JSON');
  });
});
