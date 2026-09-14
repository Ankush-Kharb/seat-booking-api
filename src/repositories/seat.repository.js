// Data access for seats, against Postgres.
//
// Written alongside the Map version rather than replacing it, so the app keeps
// working while the other three repositories and the service layer catch up. The
// old file dies at cutover, not before.
//
// Three things change shape here, and none of them are "the same code with SQL in
// it". They are worth reading in order.

/**
 * 1. Every function takes `exec` first.
 *
 *    `exec` is either the pool (the statement commits by itself) or a transaction
 *    client from withTransaction(). Both have .query(), so one implementation serves
 *    both. Without this, a repository would either always open its own transaction —
 *    making a multi-statement hold impossible to make atomic — or never be able to
 *    join one.
 *
 * 2. Mutations take ids, not objects.
 *
 *    The Map version's `setHold(seat, holdId)` worked because the Map handed back the
 *    very object every caller already held; mutating it WAS the write. There is no
 *    such object here, only rows. So the seat argument becomes a seat id.
 *
 * 3. Per-seat loops become set operations.
 *
 *    `for (const seat of seats) seatRepo.setHold(seat, hold.id)` was eight cheap Map
 *    writes. Against a database it is eight round trips inside a held transaction,
 *    which is eight times the lock duration for no reason. Every mutation below acts
 *    on the whole set in one statement. The migration does not just port the
 *    interface, it forces a better-shaped one.
 */

const COLUMNS = "id, event_id, seat_row, seat_number, label, tier, price_cents, hold_id, booking_id";

/**
 * The only place the schema's column names are spoken. `seat_row`/`seat_number` exist
 * because ROW is a reserved word in Postgres; they become row/number here, so
 * createSeat() and everything above this file keep the field names they already use.
 *
 * Note price_cents arrives as a JS number because the column is INTEGER. Had it been
 * BIGINT, node-pg would hand back a *string* — 64-bit integers do not fit a JS
 * number, so the driver refuses to lose precision silently. Worth remembering before
 * anyone "future-proofs" a money column by widening it.
 */
const toSeat = (record) => ({
  id: record.id,
  eventId: record.event_id,
  row: record.seat_row,
  number: record.seat_number,
  label: record.label,
  tier: record.tier,
  priceCents: record.price_cents,
  holdId: record.hold_id,
  bookingId: record.booking_id,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const findById = async (exec, seatId) => {
  const { rows } = await exec.query(`SELECT ${COLUMNS} FROM seats WHERE id = $1`, [seatId]);
  // undefined, not null, to match what Map.get() returned — every caller already
  // tests `=== undefined`.
  return rows.length === 0 ? undefined : toSeat(rows[0]);
};

/**
 * All seats for one event.
 *
 * The Map version got its ordering for free: Map iterates in insertion order, and
 * seed.js inserts row by row. A table has no inherent order, and a SELECT without
 * ORDER BY may return rows in any order at all — it will look stable in testing and
 * then change the day the planner picks a different scan. So the ordering that was
 * implicit has to become explicit.
 */
export const findByEventId = async (exec, eventId) => {
  const { rows } = await exec.query(
    `SELECT ${COLUMNS} FROM seats WHERE event_id = $1 ORDER BY seat_row, seat_number`,
    [eventId],
  );
  return rows.map(toSeat);
};

/**
 * Shared by the two lookups below.
 *
 * `= ANY($1::text[])` rather than `IN (...)`: a placeholder is one value, so `IN ($1)`
 * with an array does not do what you want. ANY takes the array as a single parameter,
 * which also means one query plan no matter how many ids — no string building, and
 * nothing that could become an injection site.
 *
 * The database returns a set, so the caller's requested order is gone. We rebuild it
 * from `seatIds`, which also produces missingIds in one pass.
 */
const selectByIds = async (exec, seatIds, { forUpdate }) => {
  const { rows } = await exec.query(
    `SELECT ${COLUMNS} FROM seats WHERE id = ANY($1::text[])` +
      // ORDER BY is not cosmetic here — see findManyByIdsForUpdate.
      (forUpdate ? " ORDER BY id FOR UPDATE" : ""),
    [seatIds],
  );

  const byId = new Map(rows.map((record) => [record.id, toSeat(record)]));

  const seats = [];
  const missingIds = [];
  for (const seatId of seatIds) {
    const seat = byId.get(seatId);
    if (seat === undefined) missingIds.push(seatId);
    else seats.push(seat);
  }
  return { seats, missingIds };
};

/** Plain read. Safe for GET endpoints; NOT safe as the basis of a decision to write. */
export const findManyByIds = (exec, seatIds) => selectByIds(exec, seatIds, { forUpdate: false });

/**
 * The same read, but locking every row it returns until the transaction ends.
 *
 * This is the line that replaces "there is no await between the check phase and the
 * commit phase". A concurrent transaction asking for any of these seats blocks here
 * until we commit or roll back, and then sees what we did. Without it, two requests
 * both read seat A1 as free and both claim it.
 *
 * Deliberately a separate exported function rather than an option, so that a lock is
 * visible at the call site in booking.service.js. A boolean buried in an options
 * object is exactly the kind of thing that goes missing in review.
 *
 * ORDER BY id matters, and not for presentation: it fixes the order rows are locked
 * in. Two transactions locking {A1, B2} and {B2, A1} in opposite orders will deadlock
 * — each holds what the other wants next. Postgres detects it and kills one with a
 * 40P01, so it is a failed request rather than a hang, but it is still a failure you
 * can design away. Consistent lock ordering is the same discipline as always taking
 * mutexes in the same sequence, and ORDER BY id is how you get it here.
 */
export const findManyByIdsForUpdate = (exec, seatIds) =>
  selectByIds(exec, seatIds, { forUpdate: true });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** One seat. `label` is never supplied — the column is GENERATED from row/number. */
export const insert = async (exec, seat) => {
  await exec.query(
    `INSERT INTO seats (id, event_id, seat_row, seat_number, tier, price_cents)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [seat.id, seat.eventId, seat.row, seat.number, seat.tier, seat.priceCents],
  );
  return seat;
};

/**
 * Bulk insert for seed.js, which creates 46 seats across two events. As one statement
 * instead of 46 round trips.
 *
 * UNNEST turns N parallel arrays into N rows — it is the transpose of what you have
 * in JS (an array of seat objects) into what SQL wants (a column of ids, a column of
 * event ids, ...). Hence the six `.map()` calls.
 */
export const insertMany = async (exec, seats) => {
  if (seats.length === 0) return seats;
  await exec.query(
    `INSERT INTO seats (id, event_id, seat_row, seat_number, tier, price_cents)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::int[])`,
    [
      seats.map((seat) => seat.id),
      seats.map((seat) => seat.eventId),
      seats.map((seat) => seat.row),
      seats.map((seat) => seat.number),
      seats.map((seat) => seat.tier),
      seats.map((seat) => seat.priceCents),
    ],
  );
  return seats;
};

/**
 * Point seats at a hold. The commit phase of holdSeats().
 *
 * Callers must have locked these rows with findManyByIdsForUpdate() in the same
 * transaction first. This statement does not re-check availability, exactly as the
 * Map version's setHold() did not — the check phase owns that decision.
 */
export const attachToHold = async (exec, seatIds, holdId) => {
  const { rowCount } = await exec.query(
    `UPDATE seats SET hold_id = $2 WHERE id = ANY($1::text[])`,
    [seatIds, holdId],
  );
  return rowCount;
};

/**
 * Detach every seat still owned by this hold. Replaces freeSeatsOf().
 *
 * That helper carried the subtlest comment in the service: only release what you
 * still own, because an expired hold's seat may already have been claimed by someone
 * else, and clearing the pointer would free a seat that is legitimately held. The
 * guard was `if (seat.holdId === hold.id)`.
 *
 * Here that guard IS the WHERE clause. The loop, the lookup, and the conditional all
 * collapse into one statement that cannot get it wrong.
 */
export const releaseSeatsOfHold = (exec, holdId) => releaseSeatsOfHolds(exec, [holdId]);

/**
 * Sell every seat held by this hold: attach the booking and drop the hold pointer.
 *
 * Both assignments must happen in ONE statement. The schema's seats_not_held_and_sold
 * CHECK forbids a row having both pointers set, and constraints are evaluated per
 * statement — doing this as two UPDATEs would trip it in between. The Map version got
 * away with setBooking() then setHold(null) precisely because nothing was checking.
 */
export const sellSeatsOfHold = async (exec, holdId, bookingId) => {
  const { rows } = await exec.query(
    `UPDATE seats SET booking_id = $2, hold_id = NULL
     WHERE hold_id = $1
     RETURNING ${COLUMNS}`,
    [holdId, bookingId],
  );
  // RETURNING gives back the updated rows in the same round trip, so confirmBooking
  // can total the prices without a second SELECT.
  return rows.map(toSeat);
};

/**
 * The same detach for many holds at once — the sweeper's second half, and the single
 * implementation the singular version above delegates to.
 */
export const releaseSeatsOfHolds = async (exec, holdIds) => {
  if (holdIds.length === 0) return 0;
  const { rowCount } = await exec.query(
    `UPDATE seats SET hold_id = NULL WHERE hold_id = ANY($1::text[])`,
    [holdIds],
  );
  return rowCount;
};
