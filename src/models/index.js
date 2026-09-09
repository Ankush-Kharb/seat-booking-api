// Domain models and the rules that are pure functions of a single record.
//
// There are no classes here. A "model" in this project is (a) a factory that builds
// a plain object with every field present, and (b) the constants that describe it.
// Every record in the system is created by one of these factories, so a field can
// never be silently missing on one code path and present on another.

/**
 * `Object.freeze` makes the object read-only at runtime. Without it, any file could
 * do `SEAT_STATUS.SOLD = "oops"` and quietly break every comparison in the codebase.
 * These are our substitute for a C++ `enum class`.
 */
export const SEAT_STATUS = Object.freeze({
  AVAILABLE: "available",
  HELD: "held",
  SOLD: "sold",
});

export const HOLD_STATUS = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
  CONFIRMED: "confirmed",
});

/** How long a hold survives without being extended or confirmed. */
export const DEFAULT_HOLD_TTL_MS = 2 * 60 * 1000;

/** Ceiling on any single TTL, so a client cannot ask for a 3-hour lock. */
export const MAX_HOLD_TTL_MS = 10 * 60 * 1000;

/** Ceiling on how far into the future repeated extensions can push a hold. */
export const MAX_HOLD_LIFETIME_MS = 30 * 60 * 1000;

/** A single request cannot lock more seats than this. */
export const MAX_SEATS_PER_HOLD = 8;

/**
 * The real anti-scalping limit: total seats one user may hold at once, per event.
 *
 * MAX_SEATS_PER_HOLD alone is not enough — it caps a single request, so a user could
 * simply send more of them. Twenty-five requests of eight seats will lock a 200-seat
 * venue, indefinitely, for free. This is the cap that prevents that.
 *
 * Scoped per event: holding seats for one show should not block you from another.
 * Confirmed bookings do not count — once you have paid, the seats are yours and this
 * limit is about the basket, not the purchase.
 */
export const MAX_ACTIVE_SEATS_PER_USER = 8;

export const createEvent = ({ id, name, venue, startsAt }) => ({
  id,
  name,
  venue,
  startsAt,
});

export const createSeat = ({ id, eventId, row, number, tier, priceCents }) => ({
  id,
  eventId,
  row,
  number,
  label: `${row}${number}`,
  tier,
  priceCents,
  // Pointers, not statuses. `null` means "free"; a string means "claimed by that record".
  holdId: null,
  bookingId: null,
});

export const createHold = ({ id, eventId, seatIds, userId, createdAt, expiresAt }) => ({
  id,
  eventId,
  seatIds,
  userId,
  createdAt,
  expiresAt,
  status: HOLD_STATUS.ACTIVE,
});

export const createBooking = ({ id, eventId, holdId, seatIds, userId, totalCents, createdAt }) => ({
  id,
  eventId,
  holdId,
  seatIds,
  userId,
  totalCents,
  createdAt,
});

/**
 * The single definition of "this hold still owns its seats".
 *
 * Everything that needs to know whether a seat is locked calls this, so there is
 * exactly one place where the rule lives. Note `expiresAt > now` and not `>=`:
 * a hold whose expiry equals the current instant has expired.
 */
export const isHoldActive = (hold, now) => {
  if (hold === undefined || hold === null) return false;
  if (hold.status !== HOLD_STATUS.ACTIVE) return false;
  return hold.expiresAt > now;
};

/**
 * Derive a seat's status. `hold` is the seat's current hold record, or undefined
 * if `seat.holdId` is null or points at a hold that no longer exists.
 *
 * Order matters: a sold seat stays sold even if a stale hold pointer is still on it.
 */
export const seatStatus = (seat, hold, now) => {
  if (seat.bookingId !== null) return SEAT_STATUS.SOLD;
  if (isHoldActive(hold, now)) return SEAT_STATUS.HELD;
  return SEAT_STATUS.AVAILABLE;
};
