import { config } from './config.js';
import { withTransaction, pool } from './db.js';
import { HttpError } from './errors.js';

const ORDER_SELECT = `
  SELECT o.id, o.user_id, o.event_id, o.total_cents, o.expires_at,
         CASE WHEN o.status = 'PENDING' AND o.expires_at <= now()
              THEN 'EXPIRED' ELSE o.status END AS status,
         COALESCE((SELECT array_agg(s.id ORDER BY s.id)
                   FROM seats s WHERE s.order_id = o.id), '{}') AS seat_ids
  FROM orders o`;

function toOrderDto(row) {
  return {
    orderId: row.id,
    eventId: row.event_id,
    status: row.status,
    seatIds: row.seat_ids,
    totalCents: row.total_cents,
    expiresAt: row.expires_at,
  };
}

export async function findOrder(db, orderId) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
  return rows[0] ?? null;
}

/** Returns held seats of the given orders to sale and marks the orders with newStatus. */
export async function releaseOrders(db, orderIds, newStatus) {
  await db.query(
    `UPDATE seats
        SET status = 'AVAILABLE', order_id = NULL, hold_expires_at = NULL
      WHERE order_id = ANY($1::int[]) AND status = 'HELD'`,
    [orderIds],
  );
  await db.query(
    `UPDATE orders SET status = $2 WHERE id = ANY($1::int[]) AND status = 'PENDING'`,
    [orderIds, newStatus],
  );
}

/**
 * Holds seats for a user. All-or-nothing: if any seat is unavailable the whole
 * transaction rolls back and nothing is held.
 *
 * Why this cannot double-book:
 *  1. Seat rows are locked in id order (FOR UPDATE), so two requests for the same
 *     seat are processed one after the other and overlapping requests cannot deadlock.
 *  2. The UPDATE only changes seats that are still AVAILABLE (or whose hold has
 *     expired). The second request finds the seat already HELD and updates 0 rows.
 */
export async function createOrder({ userId, eventId, seatIds, idempotencyKey }) {
  return withTransaction(async (db) => {
    // Serialises one user's own concurrent requests (idempotency and the seat limit).
    await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const { rows: replays } = await db.query(
      `${ORDER_SELECT} WHERE o.user_id = $1 AND o.idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    if (replays.length > 0) {
      return { order: toOrderDto(replays[0]), created: false };
    }

    const { rows: events } = await db.query(
      'SELECT on_sale_at <= now() AS on_sale FROM events WHERE id = $1',
      [eventId],
    );
    if (events.length === 0) {
      throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found');
    }
    if (!events[0].on_sale) {
      throw new HttpError(403, 'NOT_ON_SALE', 'Tickets for this event are not on sale yet');
    }

    const { rows: seats } = await db.query(
      `SELECT id, event_id, price_cents FROM seats
        WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [seatIds],
    );
    if (seats.length !== seatIds.length || seats.some((seat) => seat.event_id !== eventId)) {
      throw new HttpError(422, 'INVALID_SEATS', 'Every seat must exist and belong to this event');
    }

    const { rows: owned } = await db.query(
      `SELECT count(*) AS count
         FROM seats s JOIN orders o ON o.id = s.order_id
        WHERE o.user_id = $1 AND s.event_id = $2
          AND (s.status = 'SOLD' OR (s.status = 'HELD' AND s.hold_expires_at > now()))`,
      [userId, eventId],
    );
    if (owned[0].count + seatIds.length > config.maxSeatsPerUserPerEvent) {
      throw new HttpError(
        422,
        'SEAT_LIMIT',
        `You can hold or buy at most ${config.maxSeatsPerUserPerEvent} seats per event`,
      );
    }

    const totalCents = seats.reduce((sum, seat) => sum + seat.price_cents, 0);
    const { rows: inserted } = await db.query(
      `INSERT INTO orders (user_id, event_id, status, seat_count, total_cents,
                           idempotency_key, expires_at)
       VALUES ($1, $2, 'PENDING', $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING id, expires_at`,
      [userId, eventId, seatIds.length, totalCents, idempotencyKey, config.holdSeconds],
    );
    const { id: orderId, expires_at: expiresAt } = inserted[0];

    const held = await db.query(
      `UPDATE seats
          SET status = 'HELD', order_id = $1, hold_expires_at = $2
        WHERE id = ANY($3::int[])
          AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))`,
      [orderId, expiresAt, seatIds],
    );
    if (held.rowCount !== seatIds.length) {
      throw new HttpError(409, 'SEAT_UNAVAILABLE', 'One or more seats were just taken. Nothing was held.');
    }

    const order = await findOrder(db, orderId);
    return { order: toOrderDto(order), created: true };
  });
}

export async function getOrderForUser(orderId, userId) {
  const row = await findOrder(pool, orderId);
  if (!row) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  if (row.user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'This order belongs to another user');
  return toOrderDto(row);
}

export async function cancelOrder(orderId, userId) {
  await withTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT user_id, status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (rows.length === 0) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (rows[0].user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'This order belongs to another user');
    if (rows[0].status === 'PAID') {
      throw new HttpError(409, 'ALREADY_PAID', 'A paid order cannot be cancelled here');
    }
    if (rows[0].status === 'PENDING') {
      await releaseOrders(db, [orderId], 'CANCELLED');
    }
  });
}

/**
 * Pays for a pending order.
 *
 * The order row and its seats are locked first and the hold is verified BEFORE
 * the customer is charged, so nobody is charged for a seat they no longer have.
 */
export async function payOrder({ orderId, userId, paymentToken, idempotencyKey, paymentProvider }) {
  const outcome = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT user_id, status, seat_count, total_cents, expires_at <= now() AS expired
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (order.user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'This order belongs to another user');

    const { rows: previous } = await db.query(
      'SELECT status FROM payments WHERE order_id = $1 AND idempotency_key = $2',
      [orderId, idempotencyKey],
    );
    if (previous.length > 0) {
      return { kind: previous[0].status === 'SUCCEEDED' ? 'paid' : 'declined', replay: true };
    }

    if (order.status === 'PAID') {
      throw new HttpError(409, 'ALREADY_PAID', 'This order has already been paid');
    }
    if (order.status !== 'PENDING') return { kind: 'gone' };
    if (order.expired) {
      await releaseOrders(db, [orderId], 'EXPIRED');
      return { kind: 'gone' };
    }

    const { rows: held } = await db.query(
      `SELECT id FROM seats
        WHERE order_id = $1 AND status = 'HELD' AND hold_expires_at > now()
        ORDER BY id FOR UPDATE`,
      [orderId],
    );
    if (held.length !== order.seat_count) {
      await releaseOrders(db, [orderId], 'EXPIRED');
      return { kind: 'gone' };
    }

    const charge = await paymentProvider.charge({
      amountCents: order.total_cents,
      token: paymentToken,
      idempotencyKey,
    });
    await db.query(
      `INSERT INTO payments (order_id, amount_cents, provider_ref, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, order.total_cents, charge.reference, charge.ok ? 'SUCCEEDED' : 'FAILED', idempotencyKey],
    );
    if (!charge.ok) return { kind: 'declined', replay: false };

    await db.query(
      `UPDATE seats SET status = 'SOLD', hold_expires_at = NULL
        WHERE order_id = $1 AND status = 'HELD'`,
      [orderId],
    );
    await db.query(`UPDATE orders SET status = 'PAID' WHERE id = $1`, [orderId]);
    return { kind: 'paid', replay: false };
  });

  if (outcome.kind === 'gone') {
    throw new HttpError(410, 'HOLD_EXPIRED', 'Your hold expired and the seats were released. No payment was taken.');
  }
  if (outcome.kind === 'declined') {
    throw new HttpError(402, 'PAYMENT_DECLINED', 'Payment was declined. Your seats stay held until the hold expires.');
  }
  const order = await getOrderForUser(orderId, userId);
  return { order, replay: outcome.replay };
}

export async function listTickets(userId) {
  const { rows } = await pool.query(
    `SELECT s.id AS seat_id, s.section, s.row_label, s.seat_number,
            o.id AS order_id, e.id AS event_id, e.title, e.venue, e.starts_at
       FROM seats s
       JOIN orders o ON o.id = s.order_id
       JOIN events e ON e.id = s.event_id
      WHERE o.user_id = $1 AND o.status = 'PAID' AND s.status = 'SOLD'
      ORDER BY e.starts_at, s.id`,
    [userId],
  );
  return rows.map((row) => ({
    seatId: row.seat_id,
    orderId: row.order_id,
    event: { id: row.event_id, title: row.title, venue: row.venue, startsAt: row.starts_at },
    section: row.section,
    row: row.row_label,
    number: row.seat_number,
  }));
}
