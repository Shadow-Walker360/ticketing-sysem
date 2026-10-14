import pg from 'pg';
import { config } from './config.js';

// COUNT() returns BIGINT, which pg gives back as a string by default.
pg.types.setTypeParser(20, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
});

/**
 * Runs fn(client) inside one transaction. Commits if fn resolves,
 * rolls back if it throws (so a failed hold leaves nothing behind).
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}
