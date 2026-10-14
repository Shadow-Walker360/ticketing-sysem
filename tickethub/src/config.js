import 'dotenv/config';

const env = process.env;

function jwtSecret() {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return 'dev-only-secret';
}

export const config = {
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://tickethub:tickethub@localhost:5432/tickethub',
  dbPoolSize: Number(env.DB_POOL_SIZE ?? 20),
  jwtSecret: jwtSecret(),
  jwtExpiresIn: '12h',
  holdSeconds: Number(env.HOLD_SECONDS ?? 300),
  maxSeatsPerOrder: 4,
  maxSeatsPerUserPerEvent: 4,
  seatMapTtlMs: Number(env.SEAT_MAP_TTL_MS ?? 2000),
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
  trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0),
  expireIntervalMs: 30_000,
};
