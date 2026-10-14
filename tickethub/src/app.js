import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import * as defaultPaymentProvider from './paymentProvider.js';
import { createSeatMapCache } from './seatMapCache.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { orderRoutes } from './routes/orders.js';
import { userRoutes } from './routes/tickets.js';

export function createApp({
  seatMapTtlMs = config.seatMapTtlMs,
  rateLimitPerMinute = config.rateLimitPerMinute,
  paymentProvider = defaultPaymentProvider,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);

  app.use(express.json({ limit: '10kb' }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } });
      },
    }),
  );

  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

  const seatMapCache = createSeatMapCache(seatMapTtlMs);

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.use('/auth', authRoutes());
  app.use('/events', eventRoutes({ seatMapCache }));
  app.use('/orders', orderRoutes({ paymentProvider }));
  app.use('/users', userRoutes());

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large' } });
    }
    console.error(error);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}
