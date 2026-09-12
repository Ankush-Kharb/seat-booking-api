// Data access for bookings.
//
// The holdId -> bookingId index from the Map version is gone, replaced by the UNIQUE
// constraint on bookings.hold_id. That is a straight upgrade: the index made a
// duplicate confirm cheap to *detect*, the constraint makes it impossible to *write*.

import { seatIdsOfHold } from "./sql.js";

/** Postgres SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "23505";

/**
 * booking.seatIds comes from hold_seats, not from seats.booking_id.
 *
 * Either would give the right set — a booking's seats are exactly its hold's seats,
 * and booking_id is never cleared. hold_seats wins because it carries `ordinal`, so
 * the array comes back in the order the client originally sent, which is what the
 * Map version returned and what the API response has always shown.
 */
const SELECT_BOOKING = `
  SELECT b.id, b.event_id, b.hold_id, b.user_id, b.total_cents, b.created_at,
         ${seatIdsOfHold("b.hold_id")}
    FROM bookings b
`;

const toBooking = (record) => ({
  id: record.id,
  eventId: record.event_id,
  holdId: record.hold_id,
  seatIds: record.seat_ids,
  userId: record.user_id,
  totalCents: record.total_cents,
  createdAt: record.created_at.getTime(),
});

export const findById = async (exec, bookingId) => {
  const { rows } = await exec.query(`${SELECT_BOOKING} WHERE b.id = $1`, [bookingId]);
  return rows.length === 0 ? undefined : toBooking(rows[0]);
};

/** The idempotency lookup: has this hold already been turned into a booking? */
export const findByHoldId = async (exec, holdId) => {
  const { rows } = await exec.query(`${SELECT_BOOKING} WHERE b.hold_id = $1`, [holdId]);
  return rows.length === 0 ? undefined : toBooking(rows[0]);
};

/**
 * Insert a booking. Throws a UNIQUE_VIOLATION if this hold already has one — which is
 * the race the service catches and turns back into "return the existing booking".
 */
export const insert = async (exec, booking) => {
  await exec.query(
    `INSERT INTO bookings (id, event_id, hold_id, user_id, total_cents, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      booking.id,
      booking.eventId,
      booking.holdId,
      booking.userId,
      booking.totalCents,
      new Date(booking.createdAt),
    ],
  );
  return booking;
};
