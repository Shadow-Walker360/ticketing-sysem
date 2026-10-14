# TicketHub: Design Document

## 1. Context

TicketHub is a website where people browse concerts and events, pick specific seats and buy tickets. Most days it is quiet. When a popular concert goes on sale, hundreds of thousands of people arrive at the same moment and compete for a small number of seats.

The hardest problem is not the volume of traffic. It is **correctness under competition**: when 200,000 people want 20,000 seats, no seat may ever be sold twice, and the process should feel fair.

**Goals**
- Let users browse events, view seats, hold seats, pay and see their tickets.
- Never sell the same seat to two people.
- Stay online and responsive during a big sale.

**Non-goals**
- Resale or ticket transfer between users.
- Dynamic pricing.
- Refund workflows (only cancellation of unpaid holds is covered).
- Multi-currency support. We assume one currency.

## 2. Requirements

### Functional
1. Users can register and log in.
2. Users can browse and search upcoming events.
3. Users can view an event's seat map with the status of each seat.
4. Users can hold up to 4 seats for a short time (5 minutes) while they pay.
5. Users can pay for held seats and receive tickets.
6. Users can view their tickets and orders.
7. Unpaid holds expire automatically and the seats return to sale.

### Non-functional
| Area | Requirement |
|---|---|
| **Correctness** | A seat is never sold to more than one buyer, even with thousands of simultaneous requests. This is the most important requirement. |
| **Speed** | Browsing pages load in under 1 second. Seat hold requests respond in under 500 ms, even during a big sale. |
| **Fairness** | Buyers are served roughly in the order they arrived. A per-order limit of 4 seats stops one person (or bot) taking a whole venue. |
| **Availability** | 99.9% availability. The site must survive a big sale without crashing. |
| **Durability** | A paid order is never lost. |
| **Consistency of money** | A user is never charged for a seat they do not receive, and never charged twice for one order. |

## 3. Estimates

### Normal day
- Page views: 50,000 visitors x 10 pages = **500,000 page views/day**.
- Average: 500,000 / 100,000 seconds (a day rounded to 100,000 s) = **about 5 requests/second**. Allowing a 5x peak gives **about 25 requests/second**.
- Purchases: 5,000 tickets/day / 100,000 = **about 0.05 purchases/second**.
- Read to write ratio: about **100 page views for every purchase**. A normal day is read-heavy and very light.
- Storage: 5,000 tickets/day x 365 = about 1.8 million tickets per year. At roughly 500 bytes per order or seat record, that is **about 1 GB per year**. Storage is not a concern.

### Big sale (one popular concert)
- 200,000 people arrive within 10 minutes (600 seconds): **about 333 new users/second**.
- Each user makes roughly 10 requests (event page, seat map refreshes, hold, payment, confirmation): 200,000 x 10 / 600 = **about 3,300 requests/second**.
- 20,000 seats sold in 10 minutes if demand holds: **about 33 purchases/second**.
- Demand is **10 times the supply** (200,000 people for 20,000 seats), so most users will fail to get seats and must be told quickly and clearly.

### Comparison
| Measure | Normal day | Big sale | Increase |
|---|---|---|---|
| Requests/second | about 5 (25 at peak) | about 3,300 | 130x to 660x |
| Purchases/second | about 0.05 | about 33 | about 600x |
| Competition for each seat | none | about 10 buyers per seat | n/a |

**Conclusion:** the system must be sized for the big sale, not the normal day. Two separate problems appear: (1) a huge read load on the seat map, solved with caching, and (2) many simultaneous attempts on the same seats, solved with database-level atomic updates and a waiting room.

## 4. Proposed design

### 4.1 API

All endpoints are JSON over HTTPS. Endpoints marked *auth* need a logged-in user.

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `GET /events?query=&page=` | Browse and search events | 200 | 400 |
| `GET /events/{eventId}` | Event details | 200 | 404 |
| `GET /events/{eventId}/seats` | Seat map with status of each seat | 200 | 404 |
| `POST /orders` *(auth)* | Hold seats and create a pending order | 201 | 401, 409, 422, 429 |
| `GET /orders/{orderId}` *(auth)* | View an order and its hold expiry | 200 | 401, 403, 404 |
| `DELETE /orders/{orderId}` *(auth)* | Cancel a pending order and release its seats | 204 | 401, 403, 404, 409 |
| `POST /orders/{orderId}/payments` *(auth)* | Pay for a pending order | 201 | 401, 402, 403, 404, 410 |
| `GET /users/me/tickets` *(auth)* | List my tickets | 200 | 401 |

**Create a hold**

Request: `POST /orders`
```json
{
  "eventId": 42,
  "seatIds": [1011, 1012],
  "idempotencyKey": "f3a1c9e0-7b52-4c1e-9d2a-1c6b0e4d8a11"
}
```

Response: `201 Created`
```json
{
  "orderId": 9001,
  "status": "PENDING",
  "seatIds": [1011, 1012],
  "totalCents": 15000,
  "expiresAt": "2026-10-20T18:05:00Z"
}
```

Error responses:
- `409 Conflict`: one or more seats were already taken. Nothing is held (all-or-nothing).
- `422 Unprocessable Entity`: more than 4 seats requested, or the seats belong to a different event.
- `429 Too Many Requests`: rate limit exceeded or the user is not yet admitted from the waiting room.

**Pay for an order**

Request: `POST /orders/9001/payments`
```json
{ "paymentToken": "tok_abc123", "idempotencyKey": "b7d2e8f1-0c43-4a6e-8f15-92a1d3c4e5f6" }
```

Response: `201 Created`
```json
{ "orderId": 9001, "status": "PAID", "tickets": [{ "seatId": 1011 }, { "seatId": 1012 }] }
```

Error responses:
- `410 Gone`: the hold expired before payment.
- `402 Payment Required`: the payment was declined. The hold stays until it expires, so the user can retry.

The `idempotencyKey` means that if a user double-clicks or a network retry repeats the request, the server recognises the key and returns the original result instead of creating a second order or charge.

### 4.2 Data model

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  venue       TEXT NOT NULL,
  starts_at   TIMESTAMP NOT NULL,
  on_sale_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  event_id         INTEGER NOT NULL REFERENCES events(id),
  status           TEXT NOT NULL CHECK (status IN ('PENDING','PAID','EXPIRED','CANCELLED')),
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  idempotency_key  TEXT NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE seats (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  section     TEXT NOT NULL,
  row_label   TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  status      TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','HELD','SOLD')),
  order_id    INTEGER REFERENCES orders(id),   -- set while HELD or SOLD
  hold_expires_at TIMESTAMP,                   -- set while HELD
  UNIQUE (event_id, section, row_label, seat_number)
);

CREATE INDEX idx_seats_event_status ON seats (event_id, status);

CREATE TABLE payments (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  amount_cents     INTEGER NOT NULL,
  provider_ref     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Relationships**
- A **user** has many **orders** (one-to-many).
- An **event** has many **seats** and many **orders** (one-to-many each).
- An **order** has many **seats** (one-to-many through `seats.order_id`). A seat belongs to at most one order at a time.
- An **order** has one or more **payments** (one-to-many; failed attempts are kept).
- A user's **tickets** are the seats with status `SOLD` whose order belongs to that user and has status `PAID`. No separate tickets table is needed.

### 4.3 Preventing two people buying the same seat

This is the central design decision. We do **not** rely on "check if the seat is free, then save", because two requests can both see "free" at the same instant. Instead, the check and the change happen in **one atomic SQL statement**, and constraints act as a second line of defence.

**Step 1: Hold (inside one transaction).** For every seat in the request, the app runs:

```sql
UPDATE seats
SET status = 'HELD',
    order_id = :orderId,
    hold_expires_at = :expiresAt
WHERE id = :seatId
  AND event_id = :eventId
  AND (status = 'AVAILABLE'
       OR (status = 'HELD' AND hold_expires_at < CURRENT_TIMESTAMP));
```

The database locks the row while the update runs, so two simultaneous requests for the same seat are processed one after the other. The first one changes the row; the second finds the `WHERE` condition no longer true and updates **0 rows**. The app checks that the number of rows updated equals the number of seats requested. If any seat returns 0 rows, the **whole transaction is rolled back** and the user receives `409 Conflict`. The result is all-or-nothing, so nobody ends up holding half of what they wanted.

**Step 2: Pay (inside one transaction).** After the payment succeeds, the app confirms the hold is still valid and converts it:

```sql
UPDATE seats
SET status = 'SOLD', hold_expires_at = NULL
WHERE order_id = :orderId
  AND status = 'HELD'
  AND hold_expires_at >= CURRENT_TIMESTAMP;
```

If the number of rows updated is smaller than the order's seat count (the hold expired and someone else took the seat), the transaction rolls back and the payment is refunded or voided. The order is marked `EXPIRED` and the user gets `410 Gone`.

**Step 3: Release.** A background worker runs every 30 seconds and sets expired holds back to `AVAILABLE` and their orders to `EXPIRED`. Step 1 also accepts expired holds, so correctness does not depend on the worker running on time.

**Constraints as a safety net**
- A seat is a single row with a single `order_id`, so it is structurally impossible for one seat to belong to two orders.
- `UNIQUE (event_id, section, row_label, seat_number)` prevents duplicate rows for the same physical seat.
- `CHECK (status IN (...))` prevents invalid states.
- `UNIQUE (user_id, idempotency_key)` on orders and `UNIQUE (idempotency_key)` on payments prevent duplicate orders and double charges from retries.

**Why the cache is never trusted for this.** The seat map shown to users may come from a cache and can be a few seconds out of date, but the hold in Step 1 always goes to the primary database. A stale "available" seat simply results in a polite `409`, never a double sale.

### 4.4 Architecture

```
                         +---------------------+
   Browser / App ------> |  CDN (static files, |
                         |  event pages)       |
                         +----------+----------+
                                    |
                         +----------v----------+
                         |    Load balancer    |
                         |  + rate limiting    |
                         +----------+----------+
                                    |
                         +----------v----------+       +--------------------+
                         |  Waiting room       |<----->|  Redis             |
                         |  (admits users in   |       |  (queue, seat-map  |
                         |   batches)          |       |   cache, sessions) |
                         +----------+----------+       +---------+----------+
                                    |                            ^
                    +---------------+---------------+            |
                    |               |               |            |
              +-----v----+    +-----v----+    +-----v----+       |
              | App      |    | App      |    | App      |-------+
              | server 1 |    | server 2 |    | server N |
              +-----+----+    +-----+----+    +-----+----+
                    |               |               |
        +-----------+---------------+---------------+-----------+
        |                                                       |
 +------v--------------+   writes (holds, orders)   +-----------v----------+
 | Primary database    |--------------------------->| Read replicas        |
 | (PostgreSQL)        |   replication              | (browse, search)     |
 +------+--------------+                            +----------------------+
        ^
        |
 +------+---------+       +-------------------+       +-------------------+
 | Background     |       | Message queue     |------>| Email / ticket    |
 | worker         |<------| (after payment)   |       | delivery worker   |
 | (expire holds) |       +-------------------+       +-------------------+
 +----------------+
                                   App servers ----> Payment provider (external)
```

**What each component does and why it is there**

| Component | Problem it solves |
|---|---|
| **CDN** | Event pages, images and scripts are identical for everyone, so they are served from edge servers. This removes most of the read load from our servers during a sale. |
| **Load balancer with rate limiting** | Spreads requests over many servers (no single point of failure) and rejects abusive clients, answering `429`. |
| **Waiting room (queue in Redis)** | 200,000 people cannot all hit the hold endpoint at once. Users get a queue position and are admitted in batches, which protects the database and gives **fairness**: first come, first served. |
| **Stateless app servers** | Hold no user state, so any server can handle any request. We add or remove servers to match load, and a crash loses nothing. Sessions live in Redis. |
| **Redis cache** | Stores the seat map and event details for a few seconds. It absorbs the thousands of seat-map reads per second so the database is not overwhelmed. Also stores waiting-room queues and sessions. |
| **Primary database** | The single source of truth. All holds, orders and sales are written here, where row locks guarantee that a seat is sold once. |
| **Read replicas** | Serve browsing and search queries, so reads do not compete with purchases on the primary. They also take over if the primary fails. |
| **Background worker** | Releases expired holds and cleans up abandoned orders. |
| **Message queue and delivery worker** | After payment, sending the confirmation email and ticket is done asynchronously, so a slow email service never slows or breaks checkout. |
| **Payment provider** | An external service handles card data, so we never store card numbers. |

**How the design survives the big sale**
1. The CDN serves the static pages, so only API calls reach our servers.
2. The waiting room limits how many users reach checkout at once (for example 500 admitted per 10 seconds), turning a spike of about 3,300 requests/second into a steady load that the database can handle.
3. The seat map is read from the Redis cache (refreshed every 2 seconds), not the database.
4. Only the hold and payment steps touch the primary database, at roughly 33 successful sales/second, which is easily within the capacity of one well-indexed PostgreSQL server.
5. Extra app servers are added before the sale starts, because the sale time is known in advance (`on_sale_at`).
6. Slow work (emails) is moved off the critical path.

## 5. Trade-offs

1. **Waiting room: fairness and protection versus user friction.**
   Queueing users makes the sale fair and keeps the system alive, but some users must wait and may feel frustrated. We accept this because without it the site would likely crash for everyone. Showing a queue position and an estimated wait reduces the frustration.

2. **Cached seat map: speed versus freshness.**
   Showing a seat map that is up to 2 seconds old means a user may click a seat that was just taken and receive a `409`. In exchange, the database is protected from thousands of reads per second. This is safe, because the cache is only for display and the real check always happens atomically on the primary database.

3. **Seat holds: fairness to buyers versus lost sales.**
   A 5-minute hold lets users pay without losing their seats, but a seat held by someone who never pays is unavailable to others until the hold expires. A shorter hold frees seats faster but pressures users who are entering payment details. Five minutes balances the two, and the limit of 4 seats per order reduces abuse.

4. **Single primary database for writes: simplicity versus a write bottleneck.**
   One primary is easy to reason about and makes the "sold once" guarantee straightforward, since row locks and transactions work as expected. The cost is that writes cannot be spread across many servers. At roughly 33 sales/second this is comfortable. Splitting the data by event would be the next step if volume grew by an order of magnitude.

## 6. Alternatives considered

- **Check-then-insert in application code.** Rejected: two requests can both see the seat as free and both save, causing double-booking. The atomic `UPDATE ... WHERE status = 'AVAILABLE'` removes that gap.
- **Locking the whole event table during a sale.** Rejected: it would serialise every buyer and make the site extremely slow. Row-level locks only block competition for the same seat.
- **No holds: charge immediately when the user clicks a seat.** Rejected: users would be charged and then told the seat was already gone, which is a poor experience and causes refunds. Holds avoid this.
- **A NoSQL database for seats.** Rejected for now: the data is strongly relational and needs multi-row transactions (hold several seats all-or-nothing), which a relational database provides directly.

## 7. Risks and open questions

- **Bots and scalpers** may bypass the 4-seat limit by using many accounts. Possible mitigations: CAPTCHA at admission, verified phone numbers, per-card limits. Not yet decided.
- **Payment provider outage** during a sale would block checkout. Holds should be extended in that situation. The exact policy is undecided.
- **Waiting-room fairness:** queue order could be gamed by opening many tabs. We could limit one queue position per account.
- **Hold expiry during a slow payment:** a payment could succeed at the provider just after the hold expires. We handle this by voiding or refunding, but the refund process and wording to users still need to be defined.
- **Database failover:** promoting a replica takes time. The behaviour during that window (read-only mode?) needs to be agreed.