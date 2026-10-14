import { withTransaction } from '../db.js';
import { releaseOrders } from '../orders.js';

/** Releases seats whose hold has run out. Returns how many orders expired. */
export async function releaseExpiredHolds() {
  return withTransaction(async (db) => {
    // Lock orders first (same order as payOrder) and skip any being paid right now.
    const { rows } = await db.query(
      `SELECT id FROM orders
        WHERE status = 'PENDING' AND expires_at <= now()
        ORDER BY id FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length === 0) return 0;
    await releaseOrders(db, rows.map((row) => row.id), 'EXPIRED');
    return rows.length;
  });
}

export function startExpiryWorker(intervalMs, log = console) {
  const timer = setInterval(async () => {
    try {
      const expired = await releaseExpiredHolds();
      if (expired > 0) log.info(`Released holds for ${expired} expired order(s)`);
    } catch (error) {
      log.error('Failed to release expired holds', error);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
