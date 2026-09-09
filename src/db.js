// The in-memory database.
//
// This is the ONLY file that owns storage. Nothing above the repository layer is
// allowed to import it. That restriction is what makes "swap in Postgres later" an
// honest claim rather than a slogan: you would rewrite the four repositories and
// delete this file, and no service, controller, or route would change.
//
// `Map` rather than a plain object, because:
//   - keys stay exactly what you put in (object keys are coerced to strings)
//   - `.size` is O(1), and iteration order is insertion order
//   - no accidental collisions with inherited properties like "constructor"
// Lookup is O(1) either way.

/**
 * Secondary indexes exist so that no read has to scan a whole table.
 *
 *   seatIdsByEvent  — GET /events/:id/seats would otherwise scan every seat
 *                     of every event to find the ones it wants.
 *   bookingIdByHold — makes confirm idempotent in O(1): "has this hold already
 *                     produced a booking?"
 *   activeHoldIds   — the expiry sweeper walks only live holds instead of every
 *                     hold ever created, which otherwise grows without bound.
 *
 * The cost is that writes must keep the indexes in step with the primary maps.
 * That is exactly why writes are confined to the repositories.
 */
const emptyState = () => ({
  events: new Map(),        // eventId   -> Event
  seats: new Map(),         // seatId    -> Seat
  holds: new Map(),         // holdId    -> Hold
  bookings: new Map(),      // bookingId -> Booking

  seatIdsByEvent: new Map(), // eventId -> string[]
  bookingIdByHold: new Map(), // holdId -> bookingId
  activeHoldIds: new Set(),   // holdIds currently ACTIVE (may still be expired)
});

export const db = emptyState();

/**
 * Wipe every table. Tests call this between cases so one test cannot leak state
 * into the next.
 *
 * It mutates the existing `db` object rather than reassigning it, because every
 * other module already holds a reference to that object — reassigning the binding
 * here would leave them all pointing at the old, stale state.
 */
export const resetDb = () => {
  const fresh = emptyState();
  for (const key of Object.keys(fresh)) {
    db[key] = fresh[key];
  }
};
