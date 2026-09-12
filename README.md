# Seat Booking API

A ticketing API built around the one problem that makes seat booking hard: **two people
must never buy the same seat**, even when they click at the same instant.

Node 24 · Express 5 · Postgres 16 · two runtime dependencies · 51 tests, no test framework installed.

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
sweeper does exist, but all it does is tidy the `status` column and detach rows nobody
will look at again — kill it and the API is still correct. A stored-status design has the
opposite property: every missed job is a seat locked forever.

**2. The service layer never calls `Date.now()`.**
Time is a parameter. `Date.now()` is called in exactly one place per request — the
controller, at the system's edge — and passed down.

That is why the TTL tests take microseconds rather than minutes:

```js
service.holdSeats({ eventId, seatIds, userId, ttlMs: 60_000 }, T0);
assert.equal(statusOf(seat, T0 + 59_000), "held");
assert.equal(statusOf(seat, T0 + 61_000), "available");   // no waiting, no fake timers
```

**3. Check and commit are separate phases, inside one transaction.**
`holdSeats` decides against every requested seat before it mutates anything, which is
what makes a partial conflict hold *nothing*. The seats are read `FOR UPDATE`, so no
other transaction can read-then-write them until this one commits. Twenty simultaneous
requests for one seat produce exactly one 201 and nineteen clean 409s, and there is a
test that fires all twenty to prove it.

A row lock is not enough on its own. The per-user seat cap reads the user's *other*
holds, which are different rows covering different seats — so two requests from one
user for disjoint seats take no common lock, and both would pass a cap they jointly
break. That one is held by a `pg_advisory_xact_lock` on `(userId, eventId)`: a lock on
a number rather than a row, because the contended resource — this user's allowance — is
not a row. It is taken before any seat lock, so lock ordering is the same everywhere.

## Schema

Five tables, in `migrations/001_init.sql`. Two modelling decisions carry their weight:

**`hold_seats` exists because ownership and intent are different facts.** `seats.hold_id`
says which seats a hold *currently owns*, and it is cleared the moment the hold is
released. `hold_seats` says which seats it *asked for*, and is never deleted. Deriving
one from the other looks tempting and quietly breaks the API: releasing a hold returns
that hold, `seatIds` and all, and a released hold owns nothing. Bookings need no
equivalent table, because `seats.booking_id` is never cleared — sold is permanent.

**`bookings.hold_id` is `UNIQUE`, and that is the idempotency guarantee.** The in-memory
version kept a `holdId → bookingId` index, which made a duplicate confirm cheap to
*detect*. A constraint makes it impossible to *write*: two racing confirms both pass the
check, and the database refuses the second. The loser catches the unique violation and
returns the booking the winner wrote.

Seat status stays derived — there is no `status` column on `seats`, only the two nullable
pointers — so there is nothing to fall out of step with them.

---

## Deployment

Deployed on Render from `render.yaml` — build `npm ci --omit=dev`, start `npm start`,
health check on `/health`. Keeping it as a blueprint rather than dashboard settings
means the deploy config is reviewable in version control.

Two things to expect on the free tier, both consequences of the demo design rather
than bugs:

- **The first request after ~15 minutes of inactivity takes 30–60s.** The instance
  spins down when idle and cold-starts on the next request.
- **The first request also pays for a cold database connection.** The pool is empty
  after a spin-down, so the first query opens a connection before it can run.

State survives restarts: `render.yaml` provisions a free Postgres and injects
`DATABASE_URL`, and `npm start` migrates before seeding anything missing.

## Run it

Needs a Postgres. The compose file brings one up on port 5433, so it will not collide
with anything already installed:

```bash
npm install
docker compose up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/seatbooking

npm run migrate           # apply migrations/*.sql
npm start                 # http://localhost:3000, seeded with two events
npm test                  # 51 tests
npm run dev               # restart on file change
```

Tests run with `--test-concurrency=1`: the files share one database and `TRUNCATE`
between cases, so running them in parallel would have them wipe each other's data.

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
migrations/
└── 001_init.sql       tables, constraints, indexes

public/
└── index.html         browser console — dependency-free, served at /

src/
├── server.js          entrypoint: migrate, seed, listen, sweeper, graceful shutdown
├── app.js             Express wiring and middleware order
├── db.js              the Postgres pool and withTransaction — the only file that owns storage
├── migrate.js         applies migrations/*.sql, tracked in schema_migrations
├── seed.js            demo events, inserted only if absent
├── models/            record factories, status enums, isHoldActive, seatStatus
├── routes/            URL → handler
├── controllers/       parse request, call service, send JSON. No try/catch anywhere
├── services/          ★ the rules. No Express, no Date.now()
├── repositories/      SQL. Every function takes an executor — the pool, or a transaction
├── middleware/        auth stand-in, error → HTTP mapping
└── errors/            AppError carrying an HTTP status
```

Dependencies run in one direction: `routes → controllers → services → repositories → db`.
No service imports Express; no repository knows what a hold means.

## Tests

```
tests/booking.service.test.js   37 tests — rules, at a controlled clock
tests/api.test.js               14 tests — real HTTP, including the races
```

The ones that earn their keep:

- **20 concurrent requests for one seat** → exactly one 201, nineteen 409s.
- **Two users with overlapping seat ranges** → one gets everything, the other nothing.
- **The sweeper must not steal a re-held seat.** A lapsed hold is still marked `ACTIVE`
  until swept; if another user has since claimed the seat, sweeping the old hold must
  leave it alone. The guard used to be `if (seat.holdId === hold.id)` inside a loop; it
  is now the `WHERE hold_id = ANY(...)` of a single `UPDATE`, which cannot be got wrong
  in the same way — but it is still the nastiest bug in the codebase without it.
- **Confirm is idempotent** — a retried request returns the original booking rather
  than charging twice, and three *simultaneous* confirms of one hold still produce one
  booking row.
- **One user, three concurrent requests, four disjoint seats each** → 8 seats held, not
  12. No two of those requests share a seat, so row locks alone would let all three
  through; this is the test that fails if the advisory lock is ever removed.

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

The fix is a second cap on *total seats held per user, per event*, served by a partial
index (`holds (user_id, event_id) WHERE status = 'active'`) so the check reads only that
user's live holds rather than scanning every active hold in the system. Same attack now:

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

`npm run loadtest -- 5000 64` — 5,000 requests per scenario, 64 concurrent clients
against a 20-connection pool, with Postgres and the API on the same laptop:

| Scenario | Throughput | p50 | p99 | Result |
|---|---|---|---|---|
| 5,000 holds, **all for one seat** | 3,079 req/s | 19.3ms | 45.0ms | **1 × 201, 4,999 × 409** |
| 5,000 holds, one per distinct seat | 3,440 req/s | 18.2ms | 27.1ms | 5,000 × 201 |
| 5,000 seat-map reads (200 seats each) | 1,063 req/s | 59.9ms | 73.8ms | 5,000 × 200 |

Zero 5xx, zero dropped requests. The harness asserts the status distribution of every
scenario and exits non-zero if one is wrong, so the first row is a checked claim rather
than a printed one: five thousand simultaneous attempts on a single seat, exactly one
succeeded.

Three things the numbers do not say:

- **This is roughly a fifth of what the in-memory version did** — the same contention
  scenario ran at ~14,700 req/s against Maps. That is the honest price of durability: the
  old figure measured a hash-map write, this one measures a row lock, a commit and a
  socket round trip. Numbers that survive a restart are worth more than numbers that do not.
- **`PG_POOL_MAX` is the knob, not CPU.** Requests beyond the pool size queue for a
  connection, and that queue is most of what p99 measures here. Raising it past what the
  database can actually serve relocates the contention rather than removing it.
- **Fire all connections simultaneously instead of pooling them and you get
  ETIMEDOUT/ECONNRESET** — macOS caps the accept queue at `kern.ipc.somaxconn` (128 by
  default), so the kernel drops connections before Node sees them. That is a socket
  establishment limit, not a request handling one. Run `npm run loadtest -- 1000` with no
  concurrency argument to reproduce it.

## What production would change

- **Auth.** `x-user-id` becomes a verified JWT. The rest is untouched — every ownership
  check already reads `req.userId`.
- **Migrations as a release step.** `npm start` migrates on boot, which keeps the deploy
  to one command but lets a code rollback leave the schema ahead of the code. A larger
  team runs migrations separately, before the new version starts.
- **Connection budget.** Horizontal scaling is safe now — atomicity belongs to the
  database, not to one process — but every instance brings its own pool, and
  `instances × PG_POOL_MAX` must stay under the server's `max_connections`. That ceiling
  arrives well before CPU does, and PgBouncer is the usual answer.
- **Sweeper ownership.** Every instance currently runs its own sweeper. It is idempotent
  so this is harmless, just wasteful; one owner elected via an advisory lock would do.
- **Payments.** Confirm currently costs nothing. A real flow would hold seats across a
  payment authorisation, with the TTL sized to the payment provider's timeout.
- **Observability.** Structured request logs, and a metric on hold-to-booking conversion.
