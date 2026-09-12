// Data access for holds.
//
// Three of src/db.js's secondary indexes lived here — activeHoldIds,
// activeHoldIdsByUser, and the seatIds array on each hold. All three become schema:
// two partial indexes and the hold_seats table. The bookkeeping that kept them in
// step by hand is gone, which is the main thing this file is shorter for.

import { HOLD_STATUS } from "../models/index.js";
import { seatIdsOfHold } from "./sql.js";

/**
 * seatIds comes from hold_seats ordered by `ordinal`, not from seats.hold_id.
 *
 * The two answer different questions. seats.hold_id is *current ownership* and goes
 * away when the hold is released — but releaseHold() returns the released hold
 * through toHoldResponse(), which reports seatIds. Deriving from ownership would
 * return [] there, a silent API change. hold_seats is *what this hold asked for*,
 * and is never deleted.
 */
const SELECT_HOLD = `
  SELECT h.id, h.event_id, h.user_id, h.created_at, h.expires_at, h.status,
         ${seatIdsOfHold("h.id")}
    FROM holds h
`;

/**
 * Timestamps convert here and nowhere else. The domain has always treated time as
 * epoch milliseconds — isHoldActive() does `expiresAt > now`, and every service takes
 * `now` as a plain number, which is what lets the tests fast-forward a two-minute TTL
 * in zero real seconds. Storing TIMESTAMPTZ and converting at this boundary keeps
 * that design entirely intact.
 */
const toHold = (record) => ({
  id: record.id,
  eventId: record.event_id,
  seatIds: record.seat_ids,
  userId: record.user_id,
  createdAt: record.created_at.getTime(),
  expiresAt: record.expires_at.getTime(),
  status: record.status,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const findById = async (exec, holdId) => {
  const { rows } = await exec.query(`${SELECT_HOLD} WHERE h.id = $1`, [holdId]);
  return rows.length === 0 ? undefined : toHold(rows[0]);
};

/**
 * Lock one hold row for the rest of the transaction, then read it.
 *
 * Every mutation of a hold — extend, release, confirm — is read-then-write, which is
 * a lost update waiting to happen: two concurrent confirms both read status ACTIVE
 * and both proceed. Taking the row lock first makes the second one wait and then see
 * the first one's result.
 *
 * Two statements rather than one `SELECT ... FOR UPDATE` with the seat_ids
 * sub-select, because mixing row locking with an aggregate sub-select is needlessly
 * subtle. The lock costs one extra round trip and removes the doubt.
 */
export const findByIdForUpdate = async (exec, holdId) => {
  const { rows } = await exec.query(`SELECT id FROM holds WHERE id = $1 FOR UPDATE`, [holdId]);
  if (rows.length === 0) return undefined;
  return findById(exec, holdId);
};

/** Several holds at once, so a seat-availability check is one query and not N. */
export const findManyByIds = async (exec, holdIds) => {
  if (holdIds.length === 0) return [];
  const { rows } = await exec.query(`${SELECT_HOLD} WHERE h.id = ANY($1::text[])`, [holdIds]);
  return rows.map(toHold);
};

/**
 * How many seats this user currently holds for one event — the per-user cap.
 *
 * Replaces heldSeatCount()'s loop over activeHoldIdsByUser, and answers in one query
 * what was a scan plus a filter. Served by the holds_active_by_user partial index.
 *
 * `::int` on the COUNT is not decoration. COUNT returns BIGINT, and node-pg hands
 * BIGINT back as a *string*, because 64 bits do not fit a JS number and the driver
 * will not silently lose precision. Without the cast, `alreadyHeld + requested` would
 * concatenate — "4" + 8 = "48" — and the cap would pass everything.
 */
export const countActiveSeatsForUser = async (exec, userId, eventId, now) => {
  const { rows } = await exec.query(
    `SELECT COUNT(hs.seat_id)::int AS count
       FROM holds h
       JOIN hold_seats hs ON hs.hold_id = h.id
      WHERE h.user_id = $1
        AND h.event_id = $2
        AND h.status = $3
        AND h.expires_at > $4`,
    [userId, eventId, HOLD_STATUS.ACTIVE, new Date(now)],
  );
  return rows[0].count;
};

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Serialise one user's hold requests for one event, for the rest of the transaction.
 *
 * This is the lock that FOR UPDATE on the seats cannot provide, and it is the subtle
 * part of the whole migration. The per-user cap reads the user's *other* holds, which
 * are different rows covering different seats. Two requests from the same user for
 * disjoint seats therefore take no common seat lock: both read alreadyHeld = 4, both
 * pass the check, both commit, and the user ends up with 12 seats against a cap of 8.
 *
 * An advisory lock is a lock on a number of our choosing rather than on a row, which
 * is exactly what is wanted when the contended resource — this user's allowance for
 * this event — is not any single row. `_xact_` means it releases on commit or
 * rollback, so there is nothing to leak.
 *
 * The two-argument form takes two int4s; hashtext() turns each id into one. A hash
 * collision between unrelated (user, event) pairs is possible and harmless: the worst
 * case is that two unrelated requests serialise against each other for a moment.
 *
 * Always taken BEFORE any seat lock, so lock ordering stays consistent everywhere.
 */
export const lockUserEvent = async (exec, userId, eventId) => {
  await exec.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [userId, eventId]);
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert the hold and its seat list. Two statements, one transaction, always. */
export const insert = async (exec, hold) => {
  await exec.query(
    `INSERT INTO holds (id, event_id, user_id, created_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      hold.id,
      hold.eventId,
      hold.userId,
      new Date(hold.createdAt),
      new Date(hold.expiresAt),
      hold.status,
    ],
  );

  // `ordinal` is the position in the requested array, which is what preserves the
  // client's ordering. WITH ORDINALITY is the SQL feature for exactly this: it adds
  // a 1..N counter column alongside whatever the set-returning function produced.
  await exec.query(
    `INSERT INTO hold_seats (hold_id, seat_id, ordinal)
     SELECT $1, seat_id, ordinal
       FROM UNNEST($2::text[]) WITH ORDINALITY AS t(seat_id, ordinal)`,
    [hold.id, hold.seatIds],
  );

  return hold;
};

export const setStatus = async (exec, holdId, status) => {
  await exec.query(`UPDATE holds SET status = $2 WHERE id = $1`, [holdId, status]);
};

export const setExpiry = async (exec, holdId, expiresAt) => {
  await exec.query(`UPDATE holds SET expires_at = $2 WHERE id = $1`, [
    holdId,
    new Date(expiresAt),
  ]);
};

/**
 * Mark every lapsed hold RELEASED and report which ones, so the caller can free their
 * seats in the same transaction.
 *
 * The Map version walked activeHoldIds and tested each one. Here the WHERE clause is
 * the test, served by the holds_active_by_expiry partial index, and the whole sweep is
 * one statement regardless of how many holds have lapsed.
 */
export const markExpiredReleased = async (exec, now) => {
  const { rows } = await exec.query(
    `UPDATE holds
        SET status = $1
      WHERE status = $2 AND expires_at <= $3
      RETURNING id`,
    [HOLD_STATUS.RELEASED, HOLD_STATUS.ACTIVE, new Date(now)],
  );
  return rows.map((record) => record.id);
};
