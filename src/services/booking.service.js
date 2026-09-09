// The booking rules: claiming seats, extending, releasing, confirming, expiring.
//
// This file imports no Express and never calls Date.now(). Every function that
// cares about time takes `now` as a parameter, which is what lets the tests
// fast-forward a two-minute TTL in zero real seconds.

import { randomUUID } from "node:crypto";

import * as eventRepo from "../repositories/event.repository.js";
import * as seatRepo from "../repositories/seat.repository.js";
import * as holdRepo from "../repositories/hold.repository.js";
import * as bookingRepo from "../repositories/booking.repository.js";

import {
  createHold,
  createBooking,
  isHoldActive,
  seatStatus,
  HOLD_STATUS,
  SEAT_STATUS,
  DEFAULT_HOLD_TTL_MS,
  MAX_HOLD_TTL_MS,
  MAX_HOLD_LIFETIME_MS,
  MAX_SEATS_PER_HOLD,
  MAX_ACTIVE_SEATS_PER_USER,
} from "../models/index.js";

import { badRequest, notFound, forbidden, conflict, gone } from "../errors/app-error.js";
import { requireString, requireIdList, optionalInt } from "../validation.js";

const MIN_TTL_MS = 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fetch a hold, or fail with the right status: 400 bad id, 404 missing, 403 not yours. */
const loadOwnedHold = (holdId, userId) => {
  const cleanHoldId = requireString(holdId, "holdId");
  const cleanUserId = requireString(userId, "userId");

  const hold = holdRepo.findById(cleanHoldId);
  if (hold === undefined) {
    throw notFound(`No hold with id ${cleanHoldId}`, { code: "HOLD_NOT_FOUND" });
  }
  if (hold.userId !== cleanUserId) {
    throw forbidden("This hold belongs to another user", { code: "HOLD_NOT_YOURS" });
  }
  return hold;
};

/**
 * Detach a hold's seats.
 *
 * The `seat.holdId === hold.id` guard is the subtle line in this file. A hold can
 * expire without anything running: the seat map simply stops reporting it. Another
 * user may then claim that seat, overwriting `seat.holdId`. When the sweeper later
 * gets around to the original hold, the seat no longer belongs to it — and clearing
 * the pointer would free a seat somebody else legitimately holds.
 *
 * So: only release what you still own.
 */
const freeSeatsOf = (hold) => {
  for (const seatId of hold.seatIds) {
    const seat = seatRepo.findById(seatId);
    if (seat === undefined) continue;
    if (seat.holdId === hold.id) seatRepo.setHold(seat, null);
  }
};

/**
 * How many seats this user currently holds for one event.
 *
 * Only genuinely live holds count. A user whose hold lapsed, or who released it, gets
 * that allowance straight back — otherwise a browsing customer would lock themselves
 * out for half an hour after abandoning a basket.
 *
 * Reads through the per-user index, so this costs O(that user's holds), not O(every
 * active hold in the system).
 */
const heldSeatCount = (userId, eventId, now) => {
  let count = 0;
  for (const hold of holdRepo.findActiveByUser(userId)) {
    if (hold.eventId !== eventId) continue;
    if (!isHoldActive(hold, now)) continue;
    count += hold.seatIds.length;
  }
  return count;
};

/** Resolve a seat's live status, skipping the hold lookup when there is no hold. */
const statusOf = (seat, now) => {
  const hold = seat.holdId === null ? undefined : holdRepo.findById(seat.holdId);
  return seatStatus(seat, hold, now);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Claim seats for a short window. All-or-nothing: if a single requested seat is
 * unavailable, nothing is held and the caller is told exactly which seats blocked it.
 */
export const holdSeats = ({ eventId, seatIds, userId, ttlMs }, now) => {
  const cleanEventId = requireString(eventId, "eventId");
  const cleanUserId = requireString(userId, "userId");
  const cleanSeatIds = requireIdList(seatIds, "seatIds", { maxLength: MAX_SEATS_PER_HOLD });
  const ttl = optionalInt(ttlMs, "ttlMs", {
    fallback: DEFAULT_HOLD_TTL_MS,
    min: MIN_TTL_MS,
    max: MAX_HOLD_TTL_MS,
  });

  if (eventRepo.findById(cleanEventId) === undefined) {
    throw notFound(`No event with id ${cleanEventId}`, { code: "EVENT_NOT_FOUND" });
  }

  const { seats, missingIds } = seatRepo.findManyByIds(cleanSeatIds);
  if (missingIds.length > 0) {
    throw notFound("One or more seats do not exist", {
      code: "SEAT_NOT_FOUND",
      details: { seatIds: missingIds },
    });
  }

  const foreignSeatIds = seats
    .filter((seat) => seat.eventId !== cleanEventId)
    .map((seat) => seat.id);
  if (foreignSeatIds.length > 0) {
    throw badRequest("One or more seats belong to a different event", {
      code: "SEAT_EVENT_MISMATCH",
      details: { seatIds: foreignSeatIds },
    });
  }

  // --- the per-user cap ---------------------------------------------------
  //
  // MAX_SEATS_PER_HOLD caps one request; on its own it stops nothing, because a
  // client can just send more requests. Twenty-five requests of eight seats will
  // lock a 200-seat venue. This is the check that actually prevents it.
  const alreadyHeld = heldSeatCount(cleanUserId, cleanEventId, now);
  if (alreadyHeld + cleanSeatIds.length > MAX_ACTIVE_SEATS_PER_USER) {
    throw conflict(
      `You may hold at most ${MAX_ACTIVE_SEATS_PER_USER} seats at once for this event`,
      {
        code: "USER_HOLD_LIMIT_EXCEEDED",
        details: {
          limit: MAX_ACTIVE_SEATS_PER_USER,
          alreadyHeld,
          requested: cleanSeatIds.length,
        },
      },
    );
  }

  // --- check phase: decide, mutate nothing -------------------------------
  const unavailable = [];
  for (const seat of seats) {
    const status = statusOf(seat, now);
    if (status !== SEAT_STATUS.AVAILABLE) {
      unavailable.push({ seatId: seat.id, label: seat.label, status });
    }
  }
  if (unavailable.length > 0) {
    throw conflict("One or more seats are no longer available", {
      code: "SEATS_UNAVAILABLE",
      details: { unavailable },
    });
  }

  // --- commit phase: mutate, decide nothing ------------------------------
  //
  // Splitting the two is what makes this all-or-nothing. Just as important is what
  // is NOT between them: no `await`. Node runs one line of JavaScript at a time, so
  // a synchronous function runs to completion before any other request is touched.
  // Two simultaneous requests for seat A1 cannot interleave here — one runs the
  // whole check-and-commit, the other then finds the seat held and gets a 409.
  //
  // That guarantee ends the moment anything in this block awaits. Against a real
  // database the equivalent protection is a transaction with row locks, or a
  // conditional UPDATE ... WHERE hold_id IS NULL.
  const hold = createHold({
    id: randomUUID(),
    eventId: cleanEventId,
    seatIds: seats.map((seat) => seat.id),
    userId: cleanUserId,
    createdAt: now,
    expiresAt: now + ttl,
  });

  holdRepo.insert(hold);
  for (const seat of seats) seatRepo.setHold(seat, hold.id);

  return hold;
};

/** Push a live hold's expiry out, subject to a ceiling on total lifetime. */
export const extendHold = ({ holdId, userId, ttlMs }, now) => {
  const hold = loadOwnedHold(holdId, userId);
  const ttl = optionalInt(ttlMs, "ttlMs", {
    fallback: DEFAULT_HOLD_TTL_MS,
    min: MIN_TTL_MS,
    max: MAX_HOLD_TTL_MS,
  });

  if (hold.status === HOLD_STATUS.CONFIRMED) {
    throw conflict("Hold has already been confirmed", { code: "HOLD_ALREADY_CONFIRMED" });
  }
  if (!isHoldActive(hold, now)) {
    throw gone("Hold has expired or been released", {
      code: "HOLD_EXPIRED",
      details: { expiresAt: hold.expiresAt },
    });
  }

  // A client could otherwise extend forever and park seats indefinitely.
  const latestAllowed = hold.createdAt + MAX_HOLD_LIFETIME_MS;
  const newExpiry = Math.min(now + ttl, latestAllowed);

  if (newExpiry <= hold.expiresAt) {
    throw conflict("Hold has reached its maximum lifetime", {
      code: "HOLD_LIFETIME_EXCEEDED",
      details: { expiresAt: hold.expiresAt, maxLifetimeMs: MAX_HOLD_LIFETIME_MS },
    });
  }

  holdRepo.setExpiry(hold, newExpiry);
  return hold;
};

/** Give the seats back early. Releasing an already-released hold is a no-op, not an error. */
export const releaseHold = ({ holdId, userId }) => {
  const hold = loadOwnedHold(holdId, userId);

  if (hold.status === HOLD_STATUS.CONFIRMED) {
    throw conflict("Hold has already been confirmed into a booking", {
      code: "HOLD_ALREADY_CONFIRMED",
    });
  }
  if (hold.status === HOLD_STATUS.RELEASED) return hold;

  holdRepo.setStatus(hold, HOLD_STATUS.RELEASED);
  freeSeatsOf(hold);
  return hold;
};

/**
 * Turn a live hold into a permanent booking.
 *
 * Idempotent by holdId: a retried request — the client's network dropped the first
 * response — returns the original booking instead of double-charging. The check
 * comes first, before the hold's own status is consulted, because by then the hold
 * is CONFIRMED and every other branch would reject it.
 */
export const confirmBooking = ({ holdId, userId }, now) => {
  const cleanHoldId = requireString(holdId, "holdId");
  const cleanUserId = requireString(userId, "userId");

  const existing = bookingRepo.findByHoldId(cleanHoldId);
  if (existing !== undefined) {
    if (existing.userId !== cleanUserId) {
      throw forbidden("This hold belongs to another user", { code: "HOLD_NOT_YOURS" });
    }
    return existing;
  }

  const hold = loadOwnedHold(cleanHoldId, cleanUserId);

  if (hold.status === HOLD_STATUS.RELEASED) {
    throw conflict("Hold was released", { code: "HOLD_RELEASED" });
  }
  if (!isHoldActive(hold, now)) {
    // Expired on arrival: tidy up now that we have noticed, then reject.
    holdRepo.setStatus(hold, HOLD_STATUS.RELEASED);
    freeSeatsOf(hold);
    throw gone("Hold has expired", {
      code: "HOLD_EXPIRED",
      details: { expiresAt: hold.expiresAt },
    });
  }

  const { seats } = seatRepo.findManyByIds(hold.seatIds);

  // `reduce` is std::accumulate: run the function over every element, carrying a
  // running value. Here that value starts at 0 and ends as the total price.
  const totalCents = seats.reduce((sum, seat) => sum + seat.priceCents, 0);

  const booking = createBooking({
    id: randomUUID(),
    eventId: hold.eventId,
    holdId: hold.id,
    seatIds: hold.seatIds,
    userId: cleanUserId,
    totalCents,
    createdAt: now,
  });

  bookingRepo.insert(booking);
  for (const seat of seats) {
    seatRepo.setBooking(seat, booking.id);
    seatRepo.setHold(seat, null); // the booking owns the seat now
  }
  holdRepo.setStatus(hold, HOLD_STATUS.CONFIRMED);

  return booking;
};

export const getBooking = ({ bookingId, userId }) => {
  const cleanBookingId = requireString(bookingId, "bookingId");
  const cleanUserId = requireString(userId, "userId");

  const booking = bookingRepo.findById(cleanBookingId);
  if (booking === undefined) {
    throw notFound(`No booking with id ${cleanBookingId}`, { code: "BOOKING_NOT_FOUND" });
  }
  if (booking.userId !== cleanUserId) {
    throw forbidden("This booking belongs to another user", { code: "BOOKING_NOT_YOURS" });
  }
  return booking;
};

/**
 * Housekeeping: mark expired holds RELEASED and detach their seats.
 *
 * Purely an optimisation. Expiry is already correct without it, because every read
 * checks `isHoldActive`. What this buys is bounded memory — `activeHoldIds` would
 * otherwise grow forever — and a tidier `status` field. If this never ran, the API
 * would still behave correctly.
 */
export const sweepExpiredHolds = (now) => {
  let swept = 0;
  for (const hold of holdRepo.findActive()) {
    if (isHoldActive(hold, now)) continue;
    holdRepo.setStatus(hold, HOLD_STATUS.RELEASED);
    freeSeatsOf(hold);
    swept += 1;
  }
  return swept;
};
