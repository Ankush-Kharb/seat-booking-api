# Seat Booking API

A ticketing API built around the one problem that makes seat booking hard: **two people
must never buy the same seat**, even when they click at the same instant.

Node 24 · Express 5 · zero runtime dependencies beyond Express · 39 tests, no test framework installed.

---

## The problem

Naive seat booking has a race between checking and writing:

```
alice: is A12 free? → yes
bob:   is A12 free? → yes          ← both checks passed
alice: mark A12 sold
bob:   mark A12 sold               ← double-booked
```

The usual fix is a lock, but a lock held by a user who wandered off is worse than the
race — the seat is stuck forever. So this API uses **holds**: a lock with an expiry.

```
POST /holds     claim seats for 2 minutes, all-or-nothing
POST /bookings  convert the hold into a permanent booking
(silence)       the hold lapses and the seats free themselves
```

## Three decisions worth defending

**1. Seat status is derived, never stored.**
A seat carries two pointers, `holdId` and `bookingId`. Nothing writes the string
`"held"` anywhere. Status is computed at read time from the hold's expiry:

```js
if (seat.bookingId !== null) return SOLD;
if (isHoldActive(hold, now))  return HELD;
return AVAILABLE;
```

The consequence is that **expiry needs nothing to run**. A hold that lapses at 14:02
stops being reported at 14:02 whether or not any cleanup job fired. A background
sweeper does exist, but it only reclaims memory and tidies the `status` field — kill it
and the API is still correct. A stored-status design has the opposite property: every
missed job is a seat locked forever.

**2. The service layer never calls `Date.now()`.**
Time is a parameter. `Date.now()` is called in exactly one place per request — the
controller, at the system's edge — and passed down.

That is why the TTL tests take microseconds rather than minutes:

```js
service.holdSeats({ eventId, seatIds, userId, ttlMs: 60_000 }, T0);
assert.equal(statusOf(seat, T0 + 59_000), "held");
assert.equal(statusOf(seat, T0 + 61_000), "available");   // no waiting, no fake timers
```

**3. Check and commit are separate phases, with no `await` between them.**
`holdSeats` decides against every requested seat before it mutates anything, which is
what makes a partial conflict hold *nothing*. Node runs one line of JavaScript at a
time, so a synchronous function completes before another request is touched — the
check-then-commit sequence is atomic here. Twenty simultaneous requests for one seat
produce exactly one 201 and nineteen clean 409s, and there is a test that fires all
twenty to prove it.

That guarantee is a property of this in-memory design, not a general truth, and it ends
the moment anything in that block awaits. Against a real database the equivalent is a
transaction with row locks, or `UPDATE ... WHERE hold_id IS NULL`.

---

## Run it

```bash
npm install
npm start                 # http://localhost:3000, seeded with two events
npm test                  # 39 tests
npm run dev               # restart on file change
```

Then open **http://localhost:3000** for a browser console that drives every endpoint:
click seats to hold them, watch the countdown, and hit *Race* to fire 20 simultaneous
requests at a single seat and see one 201 against nineteen 409s. Every request is logged
with its status and raw JSON response.

Leave a hold to run down and the seats free themselves on screen — the sweeper only runs
every 30 seconds, so what you are watching is status being derived from the clock rather
than a cleanup job.

## Try it

Identity is the `x-user-id` header — a deliberate stand-in for real auth, marked as such
in `src/middleware/authenticate.js`.

```bash
# what's on sale
curl -s localhost:3000/events

# the seat map, with live availability
curl -s localhost:3000/events/evt-1/seats

# claim two seats (all-or-nothing)
curl -s -X POST localhost:3000/holds \
  -H 'content-type: application/json' -H 'x-user-id: alice' \
  -d '{"eventId":"evt-1","seatIds":["evt-1:A1","evt-1:A2"]}'

# → {"hold":{"id":"…","seatIds":[…],"expiresAt":"…","expiresInMs":120000}}

# someone else wants one of them
curl -s -X POST localhost:3000/holds \
  -H 'content-type: application/json' -H 'x-user-id: bob' \
  -d '{"eventId":"evt-1","seatIds":["evt-1:A2","evt-1:A3"]}'

# → 409 {"error":{"code":"SEATS_UNAVAILABLE",
#        "details":{"unavailable":[{"seatId":"evt-1:A2","label":"A2","status":"held"}]}}}
#   note A3 was NOT held — all-or-nothing

# confirm (safe to retry: same hold always yields the same booking)
curl -s -X POST localhost:3000/bookings \
  -H 'content-type: application/json' -H 'x-user-id: alice' \
  -d '{"holdId":"<id from above>"}'
```

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | liveness |
| `GET` | `/events` | — | all events |
| `GET` | `/events/:eventId/seats` | — | seat map + `{available, held, sold}` summary |
| `POST` | `/holds` | ✓ | `{eventId, seatIds[], ttlMs?}` → 201. All-or-nothing; max 8 seats per request **and** 8 held per user per event |
| `POST` | `/holds/:holdId/extend` | ✓ | `{ttlMs?}` → 200. Capped at 30 min total lifetime |
| `DELETE` | `/holds/:holdId` | ✓ | release early; releasing twice is a no-op |
| `POST` | `/bookings` | ✓ | `{holdId}` → 201. Idempotent on `holdId` |
| `GET` | `/bookings/:bookingId` | ✓ | owner only |

Every error shares one shape, produced by a single middleware:

```json
{ "error": { "code": "SEATS_UNAVAILABLE", "message": "…", "details": { } } }
```

| Status | When |
|---|---|
| 400 | malformed input, missing `x-user-id` |
| 403 | the hold or booking belongs to someone else |
| 404 | unknown event, seat, hold, booking, or route |
| 409 | seats unavailable, per-user seat cap reached, hold already confirmed, lifetime cap reached |
| 410 | the hold expired |

## Structure

```
public/
└── index.html         browser console — dependency-free, served at /

src/
├── server.js          entrypoint: seed, listen, sweeper, graceful shutdown
├── app.js             Express wiring and middleware order
├── db.js              the in-memory Maps — the only file that owns storage
├── seed.js            demo events
├── models/            record factories, status enums, isHoldActive, seatStatus
├── routes/            URL → handler
├── controllers/       parse request, call service, send JSON. No try/catch anywhere
├── services/          ★ the rules. No Express, no Date.now()
├── repositories/      data access + secondary-index maintenance. No rules
├── middleware/        auth stand-in, error → HTTP mapping
└── errors/            AppError carrying an HTTP status
```

Dependencies run in one direction: `routes → controllers → services → repositories → db`.
No service imports Express; no repository knows what a hold means.

## Tests

```
tests/booking.service.test.js   25 tests — rules, at a controlled clock
tests/api.test.js               14 tests — real HTTP, including the races
```

The ones that earn their keep:

- **20 concurrent requests for one seat** → exactly one 201, nineteen 409s.
- **Two users with overlapping seat ranges** → one gets everything, the other nothing.
- **The sweeper must not steal a re-held seat.** A lapsed hold is still marked `ACTIVE`
  until swept; if another user has since claimed the seat, sweeping the old hold must
  leave it alone. The guard is `if (seat.holdId === hold.id)` — one line, and the
  nastiest bug in the codebase without it.
- **Confirm is idempotent** — a retried request returns the original booking rather
  than charging twice.

## A bug the load testing found

The first version had `MAX_SEATS_PER_HOLD = 8` and a comment calling it an
anti-scalping limit. It wasn't one. It caps a single *request*, and nothing stopped a
user sending more:

```
scalper made 25 holds of 8 seats each
seat map: { available: 0, held: 200, sold: 0 }
real customer: 409 SEATS_UNAVAILABLE — entire venue locked by one user
```

Twenty-five requests, no payment, whole venue locked — and renewable indefinitely by
extending before each expiry.

The fix is a second cap on *total seats held per user, per event*, enforced through a
`userId -> Set<holdId>` index so the check costs O(that user's holds) rather than
scanning every active hold in the system. Same attack now:

```
scalper holds made: 1
blocked with: 409 USER_HOLD_LIMIT_EXCEEDED  {limit: 8, alreadyHeld: 8, requested: 8}
real customer: held 1 seat — venue is open
```

The allowance is returned as soon as a hold lapses or is released, so an abandoned
basket doesn't lock the customer out. Confirmed bookings don't count against it — the
cap is the basket, not the purchase. Nine tests in
`tests/booking.service.test.js` cover it, including the original attack as a permanent
regression test.

## Measured

`npm run loadtest -- 100000 128` — 100,000 requests per scenario over a 128-connection
pool, single process, in-memory store, on a laptop:

| Scenario | Throughput | p50 | p99 | Result |
|---|---|---|---|---|
| 100,000 holds, **all for one seat** | 14,712 req/s | 8.1ms | 14.2ms | **1 × 201, 99,999 × 409** |
| 100,000 holds, one per distinct seat | 17,325 req/s | 7.0ms | 15.3ms | 100,000 × 201 |
| 100,000 seat-map reads (200 seats each) | 5,517 req/s | 21.7ms | 59.2ms | 100,000 × 200 |

31s wall clock. Zero 5xx, zero dropped requests, 359MB RSS holding 100,000 seats and
100,000 holds.

The first row is the one that matters: under a hundred thousand simultaneous attempts on
a single seat, exactly one succeeded.

Three things the numbers do not say:

- **Throughput improves with volume here.** The same contention scenario runs at
  7,111 req/s over 10,000 requests and 14,712 req/s over 100,000, with p99 falling from
  95ms to 14ms. That is V8's JIT compiling hot paths once they are hot enough. Short
  benchmarks understate steady state; these figures are post-warmup.
- **These are localhost numbers on one process with an in-memory store.** Add a database
  and it dominates every figure here. Treat them as an upper bound that real persistence
  will erode, not as a capacity estimate.
- **Fire all connections simultaneously instead of pooling them and you get
  ETIMEDOUT/ECONNRESET** — macOS caps the accept queue at `kern.ipc.somaxconn` (128 by
  default), so the kernel drops connections before Node sees them. That is a socket
  establishment limit, not a request handling one. Run `npm run loadtest -- 1000` with no
  concurrency argument to reproduce it.

## What production would change

- **Storage.** Swap the four repositories for SQL; nothing above them changes. The
  in-flight check would become a transaction or a conditional `UPDATE`.
- **Auth.** `x-user-id` becomes a verified JWT. The rest is untouched — every ownership
  check already reads `req.userId`.
- **Horizontal scaling.** Single-threaded atomicity is a single-process guarantee. Two
  instances need the database, or Redis, to arbitrate.
- **Payments.** Confirm currently costs nothing. A real flow would hold seats across a
  payment authorisation, with the TTL sized to the payment provider's timeout.
- **Observability.** Structured request logs, and a metric on hold-to-booking conversion.
