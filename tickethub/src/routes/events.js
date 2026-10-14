import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { escapeLike, parseId, parsePositiveInt } from '../validate.js';

const EVENT_COLUMNS = `id, title, venue, starts_at AS "startsAt", on_sale_at AS "onSaleAt"`;

export function eventRoutes({ seatMapCache }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 100) : '';
    const page = parsePositiveInt(req.query.page, 1, { max: 100_000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 20, { max: 50 });
    const pattern = query ? `%${escapeLike(query)}%` : null;

    const { rows } = await pool.query(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE starts_at > now()
          AND ($1::text IS NULL OR title ILIKE $1 OR venue ILIKE $1)
        ORDER BY starts_at, id
        LIMIT $2 OFFSET $3`,
      [pattern, pageSize, (page - 1) * pageSize],
    );
    res.json({ page, pageSize, events: rows });
  });

  router.get('/:eventId', async (req, res) => {
    const eventId = parseId(req.params.eventId, 'eventId');
    const { rows } = await pool.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [eventId]);
    if (rows.length === 0) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found');
    res.json(rows[0]);
  });

  router.get('/:eventId/seats', async (req, res) => {
    const eventId = parseId(req.params.eventId, 'eventId');
    const seats = await seatMapCache.get(eventId, async () => {
      const { rows: events } = await pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
      if (events.length === 0) return null;
      const { rows } = await pool.query(
        `SELECT id, section, row_label AS "row", seat_number AS "number", price_cents AS "priceCents",
                CASE WHEN status = 'HELD' AND hold_expires_at <= now()
                     THEN 'AVAILABLE' ELSE status END AS status
           FROM seats
          WHERE event_id = $1
          ORDER BY section, row_label, seat_number`,
        [eventId],
      );
      return rows;
    });
    if (seats === null) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found');
    res.json({ eventId, seats });
  });

  return router;
}
