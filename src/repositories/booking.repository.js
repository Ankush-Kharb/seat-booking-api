// Data access for bookings, plus maintenance of the holdId -> bookingId index.
import { db } from "../db.js";

export const findById = (bookingId) => db.bookings.get(bookingId);

/**
 * The idempotency lookup: has this hold already been turned into a booking?
 *
 * O(1) thanks to the index. Without it, confirming a hold twice would require
 * scanning every booking to check.
 */
export const findByHoldId = (holdId) => {
  const bookingId = db.bookingIdByHold.get(holdId);
  if (bookingId === undefined) return undefined;
  return db.bookings.get(bookingId);
};

export const insert = (booking) => {
  db.bookings.set(booking.id, booking);
  db.bookingIdByHold.set(booking.holdId, booking.id);
  return booking;
};
