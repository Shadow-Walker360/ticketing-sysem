import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startExpiryWorker } from './jobs/expireHolds.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`TicketHub listening on port ${config.port}`);
});
const stopWorker = startExpiryWorker(config.expireIntervalMs);

async function shutdown() {
  stopWorker();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
