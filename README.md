# TicketHub

A backend for selling event tickets that never sells the same seat twice. It implements the API, data model and double-booking protection from `day8/ticketing-design.md`.

Stack: Node.js 22, Express 5, PostgreSQL 14+.

## Setup

1. Create the databases (the second one is used by the tests and is wiped on every run):

   ```sql
   CREATE USER tickethub WITH PASSWORD 'tickethub' CREATEDB;
   CREATE DATABASE tickethub OWNER tickethub;
   CREATE DATABASE tickethub_test OWNER tickethub;
   ```

2. Install, configure, create the tables and add sample data:

   ```bash
   npm install
   cp .env.example .env      # then edit JWT_SECRET
   npm run migrate
   npm run seed              # 2 events x 100 seats, plus demo@tickethub.test / demo-password (development only)
   npm start                 # http://localhost:3000
   ```

3. Run the tests: `npm test`

## API

All bodies are JSON. Errors look like `{ "error": { "code": "SEAT_UNAVAILABLE", "message": "..." } }`.

| Method and path | Auth | Purpose | Success | Errors |
|---|---|---|---|---|
| `POST /auth/register` | no | Create an account, returns a token | 201 | 400, 409 |
| `POST /auth/login` | no | Log in, returns a token | 200 | 400, 401 |
| `GET /events?query=&page=&pageSize=` | no | Browse and search upcoming events | 200 | 400 |
| `GET /events/{eventId}` | no | Event details | 200 | 404 |
| `GET /events/{eventId}/seats` | no | Seat map (cached for 2 s) | 200 | 404 |
| `POST /orders` | yes | Hold 1 to 4 seats | 201 (200 on a repeated key) | 400, 403, 404, 409, 422 |
| `GET /orders/{orderId}` | yes | View an order | 200 | 403, 404 |
| `DELETE /orders/{orderId}` | yes | Cancel a pending order | 204 | 403, 404, 409 |
| `POST /orders/{orderId}/payments` | yes | Pay for a pending order | 201 (200 on a repeated key) | 402, 403, 404, 409, 410 |
| `GET /users/me/tickets` | yes | My tickets | 200 | 401 |
| `GET /health` | no | Health check | 200 | |

Send `Authorization: Bearer <token>` for protected routes.

Example:

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@tickethub.test","password":"demo-password"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -X POST localhost:3000/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"eventId":1,"seatIds":[3,4],"idempotencyKey":"any-unique-string-1"}'

curl -X POST localhost:3000/orders/1/payments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"paymentToken":"tok_visa","idempotencyKey":"any-unique-string-2"}'
```

The built-in payment stub accepts any token like `tok_visa` and declines `tok_decline`.

## How double-booking is prevented

See `src/orders.js`.

1. **Hold:** the seat rows are locked in id order (`SELECT ... FOR UPDATE`), then one `UPDATE` changes only seats that are still `AVAILABLE` (or whose hold expired). If the number of updated rows is smaller than the number requested, the transaction rolls back and the user gets `409`. Two buyers for the same seat are handled one after the other, so the second updates 0 rows.
2. **Pay:** the order and its seats are locked and the hold is verified *before* the card is charged, so nobody is charged for a seat they no longer have. Then the seats become `SOLD`.
3. **Expiry:** a worker (every 30 s) releases expired holds. Correctness does not depend on it, because a hold request also accepts seats whose hold has expired.
4. **Database constraints:** the `seats_state_consistent` check rejects impossible states (for example `SOLD` with no order), and a seat is one row with one `order_id`, so it can belong to only one order.

`test/tickethub.test.js` proves this against real PostgreSQL: 150 simultaneous buyers for one seat produce exactly one winner, 100 overlapping two-seat requests produce no deadlocks or shared seats, and a simulated sale of 40 seats to 120 buyers sells each seat exactly once.

## Differences from the design document

- `orders` has a `seat_count` column, used to check that every seat of an order is still held at payment time.
- The seat limit (4 per user per event) counts seats the user already holds or owns, not only the current request.

## Not included (described in the design, needed only at real scale)

- Waiting room / queue for big sales.
- Redis (the seat map cache is in memory, per server; the interface is in `src/seatMapCache.js`).
- CDN, load balancer, read replicas.
- Message queue for confirmation emails.
- A real payment provider (replace `src/paymentProvider.js`).
- Rate limiting is per IP and in memory; behind a proxy set `TRUST_PROXY_HOPS`.
