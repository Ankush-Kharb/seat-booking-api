// Unit tests for the booking rules. No HTTP, no Express, no real clock.
//
// Every service call is awaited now. Two other things changed with Postgres, both
// visible below:
//
//   - assertFails uses assert.rejects, not assert.throws. A rejected promise is not
//     a thrown exception, and assert.throws would pass a failing test happily.
//   - Nothing is asserted on a stale object. The Map version handed back the very
//     record the service went on to mutate, so `hold.status` updated by itself after
//     a release. A row read is a snapshot: assertions go on the returned value or on
//     a fresh read.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { freshDb, seedTestEvent, T0, MINUTE } from "./helpers.js";
import { pool, closePool } from "../src/db.js";
import * as service from "../src/services/booking.service.js";
import { getSeatMap } from "../src/services/event.service.js";
import * as seatRepo from "../src/repositories/seat.repository.js";
import {
  HOLD_STATUS,
  MAX_HOLD_LIFETIME_MS,
  MAX_ACTIVE_SEATS_PER_USER,
} from "../src/models/index.js";

let eventId;
let seatIds;

beforeEach(async () => {
  ({ eventId, seatIds } = await freshDb({ seatCount: 5, priceCents: 1000 }));
});

// Without this the pool keeps a socket open and the test process never exits.
after(() => closePool());

/** Assert that a call rejects with an AppError carrying this status and code. */
const assertFails = (fn, { status, code }) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });

const statusOf = async (seatId, now) =>
  (await getSeatMap(eventId, now)).seats.find((seat) => seat.id === seatId).status;

const summaryOf = async (now) => (await getSeatMap(eventId, now)).summary;

describe("holdSeats", () => {
  test("marks the requested seats held and leaves the rest available", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[1]], userId: "alice" },
      T0,
    );

    assert.equal(hold.status, HOLD_STATUS.ACTIVE);
    assert.deepEqual(hold.seatIds, [seatIds[0], seatIds[1]]);
    assert.deepEqual(await summaryOf(T0), { available: 3, held: 2, sold: 0 });
  });

  test("is all-or-nothing: one taken seat holds none of them", async () => {
    await service.holdSeats({ eventId, seatIds: [seatIds[1]], userId: "alice" }, T0);

    await assertFails(
      () => service.holdSeats({ eventId, seatIds: [seatIds[0], seatIds[1]], userId: "bob" }, T0),
      { status: 409, code: "SEATS_UNAVAILABLE" },
    );

    // The critical assertion: bob's request touched nothing. It is a stronger claim
    // than it was — the transaction rolled back, rather than the code simply never
    // having reached its commit phase.
    assert.equal(await statusOf(seatIds[0], T0), "available");
  });

  test("reports exactly which seats blocked the request", async () => {
    await service.holdSeats({ eventId, seatIds: [seatIds[2]], userId: "alice" }, T0);

    await assert.rejects(
      () => service.holdSeats({ eventId, seatIds: [seatIds[1], seatIds[2]], userId: "bob" }, T0),
      (err) => {
        assert.deepEqual(err.details.unavailable, [
          { seatId: seatIds[2], label: "A3", status: "held" },
        ]);
        return true;
      },
    );
  });

  test("deduplicates repeated seat ids", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[0], seatIds[0]], userId: "alice" },
      T0,
    );
    assert.deepEqual(hold.seatIds, [seatIds[0]]);
  });

  test("preserves the requested seat order", async () => {
    // hold.seatIds is echoed back in the API response, and hold_seats.ordinal is what
    // keeps it in the order the client sent rather than sorted by id.
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[3], seatIds[0], seatIds[2]], userId: "alice" },
      T0,
    );
    assert.deepEqual(hold.seatIds, [seatIds[3], seatIds[0], seatIds[2]]);
  });

  test("rejects an empty seat list, an over-long one, and unknown ids", async () => {
    await assertFails(() => service.holdSeats({ eventId, seatIds: [], userId: "alice" }, T0), {
      status: 400,
      code: "BAD_REQUEST",
    });

    await assertFails(
      () => service.holdSeats({ eventId, seatIds: new Array(9).fill("x"), userId: "alice" }, T0),
      { status: 400, code: "BAD_REQUEST" },
    );

    await assertFails(() => service.holdSeats({ eventId, seatIds: ["ghost"], userId: "alice" }, T0), {
      status: 404,
      code: "SEAT_NOT_FOUND",
    });
  });

  test("rejects seats belonging to a different event", async () => {
    await assertFails(() => service.holdSeats({ eventId: "evt-other", seatIds, userId: "alice" }, T0), {
      status: 404,
      code: "EVENT_NOT_FOUND",
    });
  });

  test("requires an identity", async () => {
    await assertFails(() => service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "" }, T0), {
      status: 400,
      code: "BAD_REQUEST",
    });
  });
});

describe("per-user seat cap", () => {
  // Regression suite for a real hole: MAX_SEATS_PER_HOLD caps a single request, so on
  // its own it stops nothing — a user can send more requests. Before this cap existed,
  // 25 requests locked a 200-seat venue indefinitely, for free.

  beforeEach(async () => {
    ({ eventId, seatIds } = await freshDb({ seatCount: 24, priceCents: 1000 }));
  });

  test("a user may accumulate seats across several holds, up to the limit", async () => {
    await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 5), userId: "alice" }, T0);
    await service.holdSeats({ eventId, seatIds: seatIds.slice(5, 8), userId: "alice" }, T0);

    assert.equal((await summaryOf(T0)).held, MAX_ACTIVE_SEATS_PER_USER);
  });

  test("the seat after the limit is refused, and nothing is held", async () => {
    await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 8), userId: "alice" }, T0);

    await assertFails(() => service.holdSeats({ eventId, seatIds: [seatIds[8]], userId: "alice" }, T0), {
      status: 409,
      code: "USER_HOLD_LIMIT_EXCEEDED",
    });
    assert.equal(await statusOf(seatIds[8], T0), "available");
  });

  test("the rejection says how far over the caller is", async () => {
    await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 6), userId: "alice" }, T0);

    await assert.rejects(
      () => service.holdSeats({ eventId, seatIds: seatIds.slice(6, 10), userId: "alice" }, T0),
      (err) => {
        // alreadyHeld comes from COUNT(...)::int. Without that cast node-pg would
        // hand back the string "6", and this deepEqual is what would catch it.
        assert.deepEqual(err.details, { limit: 8, alreadyHeld: 6, requested: 4 });
        return true;
      },
    );
  });

  test("one user cannot lock a venue", async () => {
    // The original attack, as a permanent regression test.
    let made = 0;
    for (let i = 0; i + 8 <= seatIds.length; i += 8) {
      try {
        await service.holdSeats({ eventId, seatIds: seatIds.slice(i, i + 8), userId: "scalper" }, T0);
        made += 1;
      } catch {
        break;
      }
    }

    assert.equal(made, 1, "a single user should get one basket, not the whole venue");
    assert.equal((await summaryOf(T0)).available, 16);

    // And a real customer can still buy.
    const ok = await service.holdSeats({ eventId, seatIds: [seatIds[20]], userId: "customer" }, T0);
    assert.equal(ok.seatIds.length, 1);
  });

  test("concurrent requests from one user cannot exceed the cap", async () => {
    // The race the advisory lock exists for, and one the Map version could not have
    // had. Three simultaneous requests for four disjoint seats each: no two share a
    // seat, so FOR UPDATE alone would let all three through — twelve seats against a
    // cap of eight. Only a lock on (user, event) serialises them.
    const results = await Promise.allSettled([
      service.holdSeats({ eventId, seatIds: seatIds.slice(0, 4), userId: "alice" }, T0),
      service.holdSeats({ eventId, seatIds: seatIds.slice(4, 8), userId: "alice" }, T0),
      service.holdSeats({ eventId, seatIds: seatIds.slice(8, 12), userId: "alice" }, T0),
    ]);

    const granted = results.filter((r) => r.status === "fulfilled");
    const seatsHeld = granted.reduce((sum, r) => sum + r.value.seatIds.length, 0);

    assert.equal(seatsHeld, MAX_ACTIVE_SEATS_PER_USER, "the cap must hold under concurrency");
    assert.equal((await summaryOf(T0)).held, MAX_ACTIVE_SEATS_PER_USER);
  });

  test("the cap is per event, not global", async () => {
    await seedTestEvent({ eventId: "evt-other", seatCount: 10 });

    await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 8), userId: "alice" }, T0);

    // Full up on the first event, but the second is untouched.
    const other = await service.holdSeats(
      { eventId: "evt-other", seatIds: ["evt-other:A1", "evt-other:A2"], userId: "alice" },
      T0,
    );
    assert.equal(other.seatIds.length, 2);
  });

  test("an expired hold returns the allowance", async () => {
    await service.holdSeats(
      { eventId, seatIds: seatIds.slice(0, 8), userId: "alice", ttlMs: MINUTE },
      T0,
    );

    const later = T0 + 2 * MINUTE;
    const again = await service.holdSeats(
      { eventId, seatIds: seatIds.slice(8, 16), userId: "alice" },
      later,
    );
    assert.equal(again.seatIds.length, 8);
  });

  test("releasing returns the allowance immediately", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 8), userId: "alice" }, T0);

    await assertFails(() => service.holdSeats({ eventId, seatIds: [seatIds[8]], userId: "alice" }, T0), {
      status: 409,
      code: "USER_HOLD_LIMIT_EXCEEDED",
    });

    await service.releaseHold({ holdId: hold.id, userId: "alice" });
    const after = await service.holdSeats({ eventId, seatIds: [seatIds[8]], userId: "alice" }, T0);
    assert.equal(after.seatIds.length, 1);
  });

  test("confirmed seats do not count — the cap is the basket, not the purchase", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 8), userId: "alice" }, T0);
    await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    // Having bought 8, alice may start a new basket.
    const next = await service.holdSeats({ eventId, seatIds: seatIds.slice(8, 16), userId: "alice" }, T0);
    assert.equal(next.seatIds.length, 8);
  });

  test("one user's holds do not consume another user's allowance", async () => {
    await service.holdSeats({ eventId, seatIds: seatIds.slice(0, 8), userId: "alice" }, T0);
    const bob = await service.holdSeats({ eventId, seatIds: seatIds.slice(8, 16), userId: "bob" }, T0);
    assert.equal(bob.seatIds.length, 8);
  });
});

describe("expiry", () => {
  test("a hold lapses on its own, with nothing running", async () => {
    await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    assert.equal(await statusOf(seatIds[0], T0 + 59 * 1000), "held");
    // No sweeper, no timer — the seat is simply available again once time passes.
    assert.equal(await statusOf(seatIds[0], T0 + MINUTE + 1), "available");
  });

  test("expiry is exclusive: expiresAt itself is already expired", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );
    assert.equal(await statusOf(seatIds[0], hold.expiresAt), "available");
  });

  test("another user can claim a lapsed seat", async () => {
    await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    const later = T0 + 2 * MINUTE;
    const bobHold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, later);

    assert.equal(bobHold.userId, "bob");
    assert.equal(await statusOf(seatIds[0], later), "held");
  });

  test("the sweeper never frees a seat that has since been re-held", async () => {
    // The regression test for the subtlest bug in the codebase: alice's hold is still
    // marked ACTIVE when bob takes the seat, so sweeping it must not clear bob's
    // pointer. The guard used to be an `if` inside a loop; it is now the WHERE clause
    // of releaseSeatsOfHolds, which is harder to get wrong and still worth testing.
    await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    const later = T0 + 2 * MINUTE;
    await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, later);

    assert.equal(await service.sweepExpiredHolds(later), 1); // alice's hold swept
    assert.equal(await statusOf(seatIds[0], later), "held"); // bob keeps the seat

    const seat = await seatRepo.findById(pool, seatIds[0]);
    assert.equal(seat.holdId !== null, true);
  });

  test("sweeping is idempotent and reports how much it did", async () => {
    await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);
    const later = T0 + 2 * MINUTE;

    assert.equal(await service.sweepExpiredHolds(later), 1);
    assert.equal(await service.sweepExpiredHolds(later), 0);
  });
});

describe("extendHold", () => {
  test("pushes the expiry out from the current moment", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    const at = T0 + 30 * 1000;
    const extended = await service.extendHold(
      { holdId: hold.id, userId: "alice", ttlMs: 2 * MINUTE },
      at,
    );

    assert.equal(extended.expiresAt, at + 2 * MINUTE);
    assert.equal(await statusOf(seatIds[0], T0 + 90 * 1000), "held");
  });

  test("caps total lifetime so seats cannot be parked forever", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    // Extend repeatedly until the service refuses. `latest` tracks the returned hold,
    // because the original `hold` is a snapshot and no longer updates itself.
    let latest = hold;
    let at = T0;
    for (let i = 0; i < 60; i += 1) {
      at += MINUTE;
      try {
        latest = await service.extendHold({ holdId: hold.id, userId: "alice", ttlMs: 5 * MINUTE }, at);
      } catch {
        break;
      }
    }

    assert.equal(latest.expiresAt, T0 + MAX_HOLD_LIFETIME_MS);
    await assertFails(
      () => service.extendHold({ holdId: hold.id, userId: "alice", ttlMs: 5 * MINUTE }, at),
      { status: 409, code: "HOLD_LIFETIME_EXCEEDED" },
    );
  });

  test("rejects an expired hold and a hold owned by someone else", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    await assertFails(() => service.extendHold({ holdId: hold.id, userId: "bob" }, T0), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    await assertFails(() => service.extendHold({ holdId: hold.id, userId: "alice" }, T0 + 2 * MINUTE), {
      status: 410,
      code: "HOLD_EXPIRED",
    });
  });
});

describe("releaseHold", () => {
  test("frees the seats immediately", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    const released = await service.releaseHold({ holdId: hold.id, userId: "alice" });

    assert.equal(await statusOf(seatIds[0], T0), "available");
    assert.equal(released.status, HOLD_STATUS.RELEASED);
  });

  test("releasing twice is a no-op, not an error", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    await service.releaseHold({ holdId: hold.id, userId: "alice" });
    const again = await service.releaseHold({ holdId: hold.id, userId: "alice" });

    assert.equal(again.status, HOLD_STATUS.RELEASED);
  });

  test("cannot release someone else's hold, or a confirmed one", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    await assertFails(() => service.releaseHold({ holdId: hold.id, userId: "bob" }), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);
    await assertFails(() => service.releaseHold({ holdId: hold.id, userId: "alice" }), {
      status: 409,
      code: "HOLD_ALREADY_CONFIRMED",
    });
  });

  test("404 for an unknown hold id", async () => {
    await assertFails(() => service.releaseHold({ holdId: "nope", userId: "alice" }), {
      status: 404,
      code: "HOLD_NOT_FOUND",
    });
  });
});

describe("confirmBooking", () => {
  test("prices the booking from the seats and marks them sold", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[1]], userId: "alice" },
      T0,
    );

    const booking = await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    assert.equal(booking.totalCents, 2000); // two seats at 1000
    assert.deepEqual(booking.seatIds, [seatIds[0], seatIds[1]]);
    assert.deepEqual(await summaryOf(T0), { available: 3, held: 0, sold: 2 });
  });

  test("is idempotent: the same hold always yields the same booking", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    const first = await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);
    const second = await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0 + 1000);

    assert.equal(first.id, second.id);
    assert.equal(second.createdAt, first.createdAt); // not re-timestamped
    assert.equal((await summaryOf(T0)).sold, 1);
  });

  test("simultaneous confirms of one hold produce one booking", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    const results = await Promise.all([
      service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0),
      service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0),
      service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0),
    ]);

    const ids = new Set(results.map((booking) => booking.id));
    assert.equal(ids.size, 1, "all three must return the same booking");
    assert.equal((await summaryOf(T0)).sold, 1);
  });

  test("a sold seat can never be held again", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);
    await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    await assertFails(
      () => service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, T0 + 10 * MINUTE),
      { status: 409, code: "SEATS_UNAVAILABLE" },
    );
  });

  test("rejects an expired hold, whose seats are already free", async () => {
    const hold = await service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    const later = T0 + 2 * MINUTE;
    await assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "alice" }, later), {
      status: 410,
      code: "HOLD_EXPIRED",
    });

    // The Map version tidied the hold up on this path. It no longer does, because a
    // throw rolls the transaction back — and nothing depends on it: the seat derives
    // as available from expiresAt alone, and the sweeper handles the status field.
    assert.equal(await statusOf(seatIds[0], later), "available");
  });

  test("rejects a released hold and another user's hold", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    await assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "bob" }, T0), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    await service.releaseHold({ holdId: hold.id, userId: "alice" });
    await assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0), {
      status: 409,
      code: "HOLD_RELEASED",
    });
  });
});

describe("getBooking", () => {
  test("returns the booking to its owner and 403s everyone else", async () => {
    const hold = await service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);
    const booking = await service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    const fetched = await service.getBooking({ bookingId: booking.id, userId: "alice" });
    assert.equal(fetched.id, booking.id);

    await assertFails(() => service.getBooking({ bookingId: booking.id, userId: "bob" }), {
      status: 403,
      code: "BOOKING_NOT_YOURS",
    });
    await assertFails(() => service.getBooking({ bookingId: "nope", userId: "alice" }), {
      status: 404,
      code: "BOOKING_NOT_FOUND",
    });
  });
});
