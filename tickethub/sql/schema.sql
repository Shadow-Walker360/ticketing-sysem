-- TicketHub schema (PostgreSQL). Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL,
  venue      TEXT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  on_sale_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  event_id        INTEGER NOT NULL REFERENCES events(id),
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')),
  seat_count      INTEGER NOT NULL CHECK (seat_count BETWEEN 1 AND 4),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0),
  idempotency_key TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS seats (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  section         TEXT NOT NULL,
  row_label       TEXT NOT NULL,
  seat_number     INTEGER NOT NULL,
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  status          TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'SOLD')),
  order_id        INTEGER REFERENCES orders(id),
  hold_expires_at TIMESTAMPTZ,
  UNIQUE (event_id, section, row_label, seat_number),
  -- A seat's columns must always agree with its status, so a half-updated
  -- seat (for example SOLD with no order) is rejected by the database itself.
  CONSTRAINT seats_state_consistent CHECK (
    (status = 'AVAILABLE' AND order_id IS NULL     AND hold_expires_at IS NULL) OR
    (status = 'HELD'      AND order_id IS NOT NULL AND hold_expires_at IS NOT NULL) OR
    (status = 'SOLD'      AND order_id IS NOT NULL AND hold_expires_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  provider_ref    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seats_event_status ON seats (event_id, status);
CREATE INDEX IF NOT EXISTS idx_seats_order        ON seats (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_user        ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_pending_expiry ON orders (expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_payments_order     ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_events_starts_at   ON events (starts_at);
