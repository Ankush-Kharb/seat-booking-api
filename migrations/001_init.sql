-- Initial schema.
--
-- The translation of src/db.js. Each Map becomes a table; each secondary index
-- becomes a real index. The rules that lived in comments become constraints, so
-- the database refuses to hold a state the domain considers impossible.

BEGIN;

-- Ids are TEXT, not UUID. Seat ids are readable by design ('evt-1:A1', see
-- src/seed.js) so README examples can be pasted. Holds and bookings use
-- randomUUID(), which is a UUID by shape but costs nothing to store as text here,
-- and keeping one id type across all four tables avoids casts in every join.
CREATE TABLE events (
  id        TEXT PRIMARY KEY,
  name      TEXT        NOT NULL,
  venue     TEXT        NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

-- Holds are created before seats are attached to them, so this table comes next.
CREATE TABLE holds (
  id         TEXT PRIMARY KEY,
  event_id   TEXT        NOT NULL REFERENCES events(id),
  user_id    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,

  -- The equivalent of HOLD_STATUS in src/models/index.js. A CHECK rather than a
  -- native ENUM type: adding a value later is an ordinary UPDATE to the constraint
  -- instead of ALTER TYPE, which historically could not run inside a transaction.
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'confirmed')),

  -- isHoldActive() compares expires_at against a supplied `now`; a hold that never
  -- had a future expiry is nonsense regardless of when you ask.
  CONSTRAINT holds_expire_after_creation CHECK (expires_at > created_at)
);

CREATE TABLE bookings (
  id          TEXT PRIMARY KEY,
  event_id    TEXT        NOT NULL REFERENCES events(id),
  user_id     TEXT        NOT NULL,
  total_cents INTEGER     NOT NULL CHECK (total_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL,

  -- This UNIQUE is the whole idempotency guarantee of confirmBooking, and it is
  -- strictly stronger than what bookingIdByHold gave us. The Map made a retried
  -- confirm cheap to detect; this makes a double booking impossible to write, even
  -- if two concurrent transactions both read "no booking yet". The loser gets a
  -- unique-violation, which the repository translates back into "return the
  -- existing booking".
  hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id)
);

CREATE TABLE seats (
  id          TEXT PRIMARY KEY,
  event_id    TEXT    NOT NULL REFERENCES events(id),
  -- Named seat_row, not row: ROW is a reserved word in Postgres (the row
  -- constructor), so a bare `row` column will not parse. seat_number follows for
  -- symmetry. The repository maps these back to row/number, so createSeat() and
  -- everything above it keep the field names they already use.
  seat_row    TEXT    NOT NULL,
  seat_number INTEGER NOT NULL CHECK (seat_number > 0),
  tier        TEXT    NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),

  -- Pointers, not statuses — exactly as in createSeat(). NULL means free. Seat
  -- status stays derived (seatStatus()), so there is no status column to fall out
  -- of step with these two.
  hold_id    TEXT REFERENCES holds(id),
  booking_id TEXT REFERENCES bookings(id),

  -- `label` is derived in createSeat() as `${row}${number}`. GENERATED keeps that
  -- single definition in one place instead of letting writers supply their own.
  -- Requires Postgres 12+.
  label TEXT GENERATED ALWAYS AS (seat_row || seat_number::TEXT) STORED,

  UNIQUE (event_id, seat_row, seat_number),

  -- Tightening worth noticing: confirmBooking sets booking_id and clears hold_id in
  -- what will become one UPDATE, so the two are never both set. seatStatus() is
  -- nonetheless written to tolerate a stale hold pointer on a sold seat. This CHECK
  -- forbids that state outright rather than tolerating it.
  CONSTRAINT seats_not_held_and_sold CHECK (booking_id IS NULL OR hold_id IS NULL)
);

-- The one genuine modelling decision.
--
-- hold.seatIds is a JS array today. The obvious move is to drop it and derive the
-- list from seats.hold_id — but that silently breaks the API: releaseHold() returns
-- the released hold through toHoldResponse(), which reports seatIds, and a released
-- hold owns no seats any more. Derivation would return [] there.
--
-- So the two facts are genuinely different and both need storing:
--   hold_seats     — which seats this hold ASKED for. Permanent, never deleted.
--   seats.hold_id  — which seats this hold currently OWNS. Revocable.
--
-- Bookings need no equivalent table: seats.booking_id is never cleared ("sold is
-- permanent"), so booking.seatIds derives safely from WHERE booking_id = $1.
CREATE TABLE hold_seats (
  hold_id TEXT NOT NULL REFERENCES holds(id),
  seat_id TEXT NOT NULL REFERENCES seats(id),

  -- Position in the seatIds array the client sent. requireIdList() dedupes but
  -- preserves request order, and hold.seatIds is echoed back in the API response, so
  -- that order is observable. A table has no order of its own; without this column
  -- the array would come back sorted by id, which is a silent API change.
  ordinal INTEGER NOT NULL,

  PRIMARY KEY (hold_id, seat_id),
  UNIQUE (hold_id, ordinal)
);

-- ---------------------------------------------------------------------------
-- Indexes: one per secondary index in src/db.js, for the same reasons.
-- ---------------------------------------------------------------------------

-- seatIdsByEvent — GET /events/:id/seats would otherwise scan every seat.
CREATE INDEX seats_by_event ON seats (event_id);

-- Makes freeSeatsOf() a single UPDATE ... WHERE hold_id = $1. Partial, because the
-- overwhelming majority of seats are free and NULLs are not worth indexing.
CREATE INDEX seats_by_hold ON seats (hold_id) WHERE hold_id IS NOT NULL;

-- activeHoldIdsByUser — the per-user seat cap. Partial on status so the index holds
-- only live holds, which is precisely what the Set did.
CREATE INDEX holds_active_by_user ON holds (user_id, event_id) WHERE status = 'active';

-- activeHoldIds — the sweeper walks live holds by expiry instead of every hold ever
-- created, which is what kept that Set bounded.
CREATE INDEX holds_active_by_expiry ON holds (expires_at) WHERE status = 'active';

COMMIT;
