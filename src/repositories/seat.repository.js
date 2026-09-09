// Data access for seats, plus maintenance of the eventId -> seatIds index.
import { db } from "../db.js";

export const findById = (seatId) => db.seats.get(seatId);

/**
 * All seats for one event, in the order they were inserted.
 *
 * This is why `seatIdsByEvent` exists: without it we would iterate every seat in
 * the database and filter by eventId — O(all seats) on a request that should cost
 * O(seats in this event).
 */
export const findByEventId = (eventId) => {
  const seatIds = db.seatIdsByEvent.get(eventId);
  if (seatIds === undefined) return [];
  return seatIds.map((seatId) => db.seats.get(seatId));
};

/**
 * Look up many seats at once and report which ids did not exist, so the caller can
 * reject the whole request before mutating anything.
 */
export const findManyByIds = (seatIds) => {
  const seats = [];
  const missingIds = [];
  for (const seatId of seatIds) {
    const seat = db.seats.get(seatId);
    if (seat === undefined) missingIds.push(seatId);
    else seats.push(seat);
  }
  return { seats, missingIds };
};

export const insert = (seat) => {
  db.seats.set(seat.id, seat);

  // Keep the index in step. A seat is never inserted without landing in its event's list.
  const existing = db.seatIdsByEvent.get(seat.eventId);
  if (existing === undefined) db.seatIdsByEvent.set(seat.eventId, [seat.id]);
  else existing.push(seat.id);

  return seat;
};

/** Point a seat at a hold, or pass null to clear it. */
export const setHold = (seat, holdId) => {
  seat.holdId = holdId;
};

/** Point a seat at a booking. Once set, this is never cleared — sold is permanent. */
export const setBooking = (seat, bookingId) => {
  seat.bookingId = bookingId;
};
