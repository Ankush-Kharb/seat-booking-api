// The booking rules: claiming seats, extending, releasing, confirming, expiring.
//
// This file imports no Express and never calls Date.now(). Every function that cares
// about time takes `now` as a parameter, which is what lets the tests fast-forward a
// two-minute TTL in zero real seconds.
//
// ---------------------------------------------------------------------------
// What changed when the Maps became Postgres
// ---------------------------------------------------------------------------
//
// The old holdSeats() had a comment explaining that its check phase and commit phase
// were safe because nothing between them awaited: Node runs one line of JavaScript at
// a time, so a synchronous function runs to completion before any other request is
// touched. Atomicity was a free side effect of being single-threaded.
//
// Every line below now awaits. That guarantee is gone, and everything it used to give
// us has to be asked for explicitly:
//
//   withTransaction   — all-or-nothing across several statements
//   FOR UPDATE        — nobody else may read-then-write these seats until we commit
//   advisory lock     — the per-user cap, which no row lock can protect (see below)
//
// Reads stay outside transactions and go straight to the pool. A transaction is for
// protecting a decision you are about to write, not for reading.

import { randomUUID } from "node:crypto";

import { pool, withTransaction } from "../db.js";
import * as eventRepo from "../repositories/event.repository.js";
import * as seatRepo from "../repositories/seat.repository.js";
import * as holdRepo from "../repositories/hold.repository.js";
import * as bookingRepo from "../repositories/booking.repository.js";
import { UNIQUE_VIOLATION } from "../repositories/booking.repository.js";
import { loadHoldsFor, statusOf } from "./seat-availability.js";

import {
  createHold,
  createBooking,
  isHoldActive,
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

/** The same bounds apply whether a hold is being created or extended. */
const parseTtl = (ttlMs) =>
  optionalInt(ttlMs, "ttlMs", {
    fallback: DEFAULT_HOLD_TTL_MS,
    min: MIN_TTL_MS,
    max: MAX_HOLD_TTL_MS,
  });

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a hold and lock its row, or fail with the right status: 404 missing,
 * 403 not yours.
 *
 * The lock is the point. Extend, release and confirm are all read-then-write, and
 * without it two concurrent requests both read status ACTIVE and both act on it.
 */
const loadOwnedHold = async (exec, holdId, userId) => {
  const hold = await holdRepo.findByIdForUpdate(exec, holdId);
  if (hold === undefined) {
    throw notFound(`No hold with id ${holdId}`, { code: "HOLD_NOT_FOUND" });
  }
  if (hold.userId !== userId) {
    throw forbidden("This hold belongs to another user", { code: "HOLD_NOT_YOURS" });
  }
  return hold;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Claim seats for a short window. All-or-nothing: if a single requested seat is
 * unavailable, nothing is held and the caller is told exactly which seats blocked it.
 */
export const holdSeats = async ({ eventId, seatIds, userId, ttlMs }, now) => {
  // Validation runs before the transaction opens. There is no reason to occupy a
  // pooled connection while rejecting a malformed body.
  const cleanEventId = requireString(eventId, "eventId");
  const cleanUserId = requireString(userId, "userId");
  const cleanSeatIds = requireIdList(seatIds, "seatIds", { maxLength: MAX_SEATS_PER_HOLD });
  const ttl = parseTtl(ttlMs);

  return withTransaction(async (tx) => {
    // --- lock ordering: the advisory lock is always taken first ------------
    //
    // It serialises this user's hold requests for this event, which is what makes
    // the cap check below trustworthy. Taking it before any seat lock keeps the
    // ordering identical on every path, so two transactions can never hold one
    // lock each and wait on the other's.
    await holdRepo.lockUserEvent(tx, cleanUserId, cleanEventId);

    if ((await eventRepo.findById(tx, cleanEventId)) === undefined) {
      throw notFound(`No event with id ${cleanEventId}`, { code: "EVENT_NOT_FOUND" });
    }

    // FOR UPDATE, ordered by seat id inside the repository. From here until commit,
    // no other transaction can read these seats for a write of its own.
    const { seats, missingIds } = await seatRepo.findManyByIdsForUpdate(tx, cleanSeatIds);
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
    // client can just send more requests. This is the check that actually prevents it.
    //
    // Note what protects it: the advisory lock above, NOT the seat locks. Two
    // requests from this user for *different* seats share no seat row, so FOR UPDATE
    // would let both read alreadyHeld = 4 and both commit — 12 seats against a cap
    // of 8. The contended resource is the allowance, which is not a row.
    const alreadyHeld = await holdRepo.countActiveSeatsForUser(
      tx,
      cleanUserId,
      cleanEventId,
      now,
    );
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
    const holdsById = await loadHoldsFor(tx, seats);
    const unavailable = [];
    for (const seat of seats) {
      const status = statusOf(seat, holdsById, now);
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
    // Throwing anywhere above rolls the whole thing back, so "all-or-nothing" is now
    // the transaction's job rather than a property of the code's shape.
    const hold = createHold({
      id: randomUUID(),
      eventId: cleanEventId,
      seatIds: seats.map((seat) => seat.id),
      userId: cleanUserId,
      createdAt: now,
      expiresAt: now + ttl,
    });

    await holdRepo.insert(tx, hold);
    await seatRepo.attachToHold(tx, hold.seatIds, hold.id);

    return hold;
  });
};

/** Push a live hold's expiry out, subject to a ceiling on total lifetime. */
export const extendHold = async ({ holdId, userId, ttlMs }, now) => {
  const cleanHoldId = requireString(holdId, "holdId");
  const cleanUserId = requireString(userId, "userId");
  const ttl = parseTtl(ttlMs);

  return withTransaction(async (tx) => {
    const hold = await loadOwnedHold(tx, cleanHoldId, cleanUserId);

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

    await holdRepo.setExpiry(tx, hold.id, newExpiry);

    // A fresh object, not a mutated one. The Map version handed back the very record
    // every caller already held, so mutating it updated everyone's view at once.
    // A row read is a snapshot: the only way the caller sees the new expiry is if we
    // return it.
    return { ...hold, expiresAt: newExpiry };
  });
};

/** Give the seats back early. Releasing an already-released hold is a no-op, not an error. */
export const releaseHold = async ({ holdId, userId }) => {
  const cleanHoldId = requireString(holdId, "holdId");
  const cleanUserId = requireString(userId, "userId");

  return withTransaction(async (tx) => {
    const hold = await loadOwnedHold(tx, cleanHoldId, cleanUserId);

    if (hold.status === HOLD_STATUS.CONFIRMED) {
      throw conflict("Hold has already been confirmed into a booking", {
        code: "HOLD_ALREADY_CONFIRMED",
      });
    }
    if (hold.status === HOLD_STATUS.RELEASED) return hold;

    await holdRepo.setStatus(tx, hold.id, HOLD_STATUS.RELEASED);
    await seatRepo.releaseSeatsOfHold(tx, hold.id);

    return { ...hold, status: HOLD_STATUS.RELEASED };
  });
};

/**
 * Turn a live hold into a permanent booking.
 *
 * Idempotent by holdId: a retried request — the client's network dropped the first
 * response — returns the original booking instead of double-charging.
 *
 * Two mechanisms, deliberately belt and braces:
 *
 *   1. The hold row is locked first, so a concurrent second confirm waits, then sees
 *      the booking the first one wrote and returns it. This is the normal path.
 *   2. bookings.hold_id is UNIQUE, so even if two transactions somehow got past the
 *      check, the database refuses the second write. The catch below turns that
 *      refusal back into the same idempotent answer.
 *
 * The Map version had only the equivalent of (1), and got it for free by being
 * single-threaded.
 */
export const confirmBooking = async ({ holdId, userId }, now) => {
  const cleanHoldId = requireString(holdId, "holdId");
  const cleanUserId = requireString(userId, "userId");

  try {
    return await withTransaction(async (tx) => {
      const hold = await loadOwnedHold(tx, cleanHoldId, cleanUserId);

      // Checked after the ownership test, so somebody else's hold is a 403 rather
      // than a leaked booking, and before the status tests, because by the time a
      // replay arrives the hold is CONFIRMED and every branch below would reject it.
      const existing = await bookingRepo.findByHoldId(tx, cleanHoldId);
      if (existing !== undefined) return existing;

      if (hold.status === HOLD_STATUS.RELEASED) {
        throw conflict("Hold was released", { code: "HOLD_RELEASED" });
      }
      if (!isHoldActive(hold, now)) {
        // The Map version tidied up here — marked the hold RELEASED and freed its
        // seats — before rejecting. That cannot work inside a transaction: the throw
        // rolls the cleanup back, so it would be code that never takes effect.
        //
        // Nothing is lost by dropping it. Expiry has never depended on cleanup: every
        // read derives "expired" from expiresAt, so the seats already read as
        // available, and the sweeper will tidy the status field shortly.
        throw gone("Hold has expired", {
          code: "HOLD_EXPIRED",
          details: { expiresAt: hold.expiresAt },
        });
      }

      const { seats } = await seatRepo.findManyByIds(tx, hold.seatIds);

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

      // Order is forced by the foreign key: seats.booking_id references bookings.id,
      // so the booking row must exist before any seat may point at it.
      await bookingRepo.insert(tx, booking);
      await seatRepo.sellSeatsOfHold(tx, hold.id, booking.id);
      await holdRepo.setStatus(tx, hold.id, HOLD_STATUS.CONFIRMED);

      return booking;
    });
  } catch (err) {
    // The backstop. A unique violation here means another transaction booked this
    // hold between our check and our insert. Its transaction is committed, ours is
    // rolled back, so the answer is simply to go and read what it wrote.
    if (err.code === UNIQUE_VIOLATION) {
      const existing = await bookingRepo.findByHoldId(pool, cleanHoldId);
      if (existing !== undefined && existing.userId === cleanUserId) return existing;
    }
    throw err;
  }
};

export const getBooking = async ({ bookingId, userId }) => {
  const cleanBookingId = requireString(bookingId, "bookingId");
  const cleanUserId = requireString(userId, "userId");

  const booking = await bookingRepo.findById(pool, cleanBookingId);
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
 * checks isHoldActive. What it buys is a tidier `status` field and seats that stop
 * pointing at holds nobody will look at again.
 *
 * Two statements instead of the old loop, and the "only release what you still own"
 * guard is now the WHERE clause in releaseSeatsOfHolds: a seat re-held by someone
 * else has a different hold_id and is simply not matched.
 */
export const sweepExpiredHolds = async (now) =>
  withTransaction(async (tx) => {
    const expiredIds = await holdRepo.markExpiredReleased(tx, now);
    if (expiredIds.length === 0) return 0;
    await seatRepo.releaseSeatsOfHolds(tx, expiredIds);
    return expiredIds.length;
  });
