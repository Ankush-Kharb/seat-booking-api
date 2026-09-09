// Unit tests for the booking rules. No HTTP, no Express, no real clock.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { freshDb, T0, MINUTE } from "./helpers.js";
import * as service from "../src/services/booking.service.js";
import { getSeatMap } from "../src/services/event.service.js";
import * as seatRepo from "../src/repositories/seat.repository.js";
import { HOLD_STATUS, MAX_HOLD_LIFETIME_MS } from "../src/models/index.js";

let eventId;
let seatIds;

beforeEach(() => {
  ({ eventId, seatIds } = freshDb({ seatCount: 5, priceCents: 1000 }));
});

/** Assert that a call throws an AppError with this status and code. */
const assertFails = (fn, { status, code }) => {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
};

const statusOf = (seatId, now) =>
  getSeatMap(eventId, now).seats.find((seat) => seat.id === seatId).status;

describe("holdSeats", () => {
  test("marks the requested seats held and leaves the rest available", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[1]], userId: "alice" },
      T0,
    );

    assert.equal(hold.status, HOLD_STATUS.ACTIVE);
    assert.deepEqual(hold.seatIds, [seatIds[0], seatIds[1]]);
    assert.deepEqual(getSeatMap(eventId, T0).summary, { available: 3, held: 2, sold: 0 });
  });

  test("is all-or-nothing: one taken seat holds none of them", () => {
    service.holdSeats({ eventId, seatIds: [seatIds[1]], userId: "alice" }, T0);

    assertFails(
      () => service.holdSeats({ eventId, seatIds: [seatIds[0], seatIds[1]], userId: "bob" }, T0),
      { status: 409, code: "SEATS_UNAVAILABLE" },
    );

    // The critical assertion: bob's request touched nothing.
    assert.equal(statusOf(seatIds[0], T0), "available");
  });

  test("reports exactly which seats blocked the request", () => {
    service.holdSeats({ eventId, seatIds: [seatIds[2]], userId: "alice" }, T0);

    assert.throws(
      () => service.holdSeats({ eventId, seatIds: [seatIds[1], seatIds[2]], userId: "bob" }, T0),
      (err) => {
        assert.deepEqual(err.details.unavailable, [
          { seatId: seatIds[2], label: "A3", status: "held" },
        ]);
        return true;
      },
    );
  });

  test("deduplicates repeated seat ids", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[0], seatIds[0]], userId: "alice" },
      T0,
    );
    assert.deepEqual(hold.seatIds, [seatIds[0]]);
  });

  test("rejects an empty seat list, an over-long one, and unknown ids", () => {
    assertFails(() => service.holdSeats({ eventId, seatIds: [], userId: "alice" }, T0), {
      status: 400,
      code: "BAD_REQUEST",
    });

    assertFails(
      () => service.holdSeats({ eventId, seatIds: new Array(9).fill("x"), userId: "alice" }, T0),
      { status: 400, code: "BAD_REQUEST" },
    );

    assertFails(() => service.holdSeats({ eventId, seatIds: ["ghost"], userId: "alice" }, T0), {
      status: 404,
      code: "SEAT_NOT_FOUND",
    });
  });

  test("rejects seats belonging to a different event", () => {
    assertFails(
      () => service.holdSeats({ eventId: "evt-other", seatIds, userId: "alice" }, T0),
      { status: 404, code: "EVENT_NOT_FOUND" },
    );
  });

  test("requires an identity", () => {
    assertFails(() => service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "" }, T0), {
      status: 400,
      code: "BAD_REQUEST",
    });
  });
});

describe("expiry", () => {
  test("a hold lapses on its own, with nothing running", () => {
    service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    assert.equal(statusOf(seatIds[0], T0 + 59 * 1000), "held");
    // No sweeper, no timer — the seat is simply available again once time passes.
    assert.equal(statusOf(seatIds[0], T0 + MINUTE + 1), "available");
  });

  test("expiry is exclusive: expiresAt itself is already expired", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );
    assert.equal(statusOf(seatIds[0], hold.expiresAt), "available");
  });

  test("another user can claim a lapsed seat", () => {
    service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    const later = T0 + 2 * MINUTE;
    const bobHold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, later);

    assert.equal(bobHold.userId, "bob");
    assert.equal(statusOf(seatIds[0], later), "held");
  });

  test("the sweeper never frees a seat that has since been re-held", () => {
    // This is the regression test for the subtlest bug in the codebase: alice's hold
    // is still marked ACTIVE when bob takes the seat, so sweeping it must not clear
    // bob's pointer.
    service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);

    const later = T0 + 2 * MINUTE;
    service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, later);

    assert.equal(service.sweepExpiredHolds(later), 1); // alice's hold swept
    assert.equal(statusOf(seatIds[0], later), "held"); // bob keeps the seat
    assert.equal(seatRepo.findById(seatIds[0]).holdId !== null, true);
  });

  test("sweeping is idempotent and reports how much it did", () => {
    service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE }, T0);
    const later = T0 + 2 * MINUTE;

    assert.equal(service.sweepExpiredHolds(later), 1);
    assert.equal(service.sweepExpiredHolds(later), 0);
  });
});

describe("extendHold", () => {
  test("pushes the expiry out from the current moment", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    const at = T0 + 30 * 1000;
    const extended = service.extendHold({ holdId: hold.id, userId: "alice", ttlMs: 2 * MINUTE }, at);

    assert.equal(extended.expiresAt, at + 2 * MINUTE);
    assert.equal(statusOf(seatIds[0], T0 + 90 * 1000), "held");
  });

  test("caps total lifetime so seats cannot be parked forever", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    // Extend repeatedly until the service refuses. The bound just stops a runaway
    // loop if the cap ever stops working.
    let at = T0;
    for (let i = 0; i < 60; i += 1) {
      at += MINUTE;
      try {
        service.extendHold({ holdId: hold.id, userId: "alice", ttlMs: 5 * MINUTE }, at);
      } catch {
        break;
      }
    }

    assert.equal(hold.expiresAt, T0 + MAX_HOLD_LIFETIME_MS);
    assertFails(
      () => service.extendHold({ holdId: hold.id, userId: "alice", ttlMs: 5 * MINUTE }, at),
      { status: 409, code: "HOLD_LIFETIME_EXCEEDED" },
    );
  });

  test("rejects an expired hold and a hold owned by someone else", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    assertFails(() => service.extendHold({ holdId: hold.id, userId: "bob" }, T0), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    assertFails(
      () => service.extendHold({ holdId: hold.id, userId: "alice" }, T0 + 2 * MINUTE),
      { status: 410, code: "HOLD_EXPIRED" },
    );
  });
});

describe("releaseHold", () => {
  test("frees the seats immediately", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    service.releaseHold({ holdId: hold.id, userId: "alice" });

    assert.equal(statusOf(seatIds[0], T0), "available");
    assert.equal(hold.status, HOLD_STATUS.RELEASED);
  });

  test("releasing twice is a no-op, not an error", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    service.releaseHold({ holdId: hold.id, userId: "alice" });
    const again = service.releaseHold({ holdId: hold.id, userId: "alice" });

    assert.equal(again.status, HOLD_STATUS.RELEASED);
  });

  test("cannot release someone else's hold, or a confirmed one", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    assertFails(() => service.releaseHold({ holdId: hold.id, userId: "bob" }), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);
    assertFails(() => service.releaseHold({ holdId: hold.id, userId: "alice" }), {
      status: 409,
      code: "HOLD_ALREADY_CONFIRMED",
    });
  });

  test("404 for an unknown hold id", () => {
    assertFails(() => service.releaseHold({ holdId: "nope", userId: "alice" }), {
      status: 404,
      code: "HOLD_NOT_FOUND",
    });
  });
});

describe("confirmBooking", () => {
  test("prices the booking from the seats and marks them sold", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0], seatIds[1]], userId: "alice" },
      T0,
    );

    const booking = service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    assert.equal(booking.totalCents, 2000); // two seats at 1000
    assert.deepEqual(booking.seatIds, [seatIds[0], seatIds[1]]);
    assert.deepEqual(getSeatMap(eventId, T0).summary, { available: 3, held: 0, sold: 2 });
  });

  test("is idempotent: the same hold always yields the same booking", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    const first = service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);
    const second = service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0 + 1000);

    assert.equal(first.id, second.id);
    assert.equal(second.createdAt, first.createdAt); // not re-timestamped
    assert.equal(getSeatMap(eventId, T0).summary.sold, 1);
  });

  test("a sold seat can never be held again", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);
    service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    assertFails(
      () => service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "bob" }, T0 + 10 * MINUTE),
      { status: 409, code: "SEATS_UNAVAILABLE" },
    );
  });

  test("rejects an expired hold and frees its seats on the way out", () => {
    const hold = service.holdSeats(
      { eventId, seatIds: [seatIds[0]], userId: "alice", ttlMs: MINUTE },
      T0,
    );

    const later = T0 + 2 * MINUTE;
    assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "alice" }, later), {
      status: 410,
      code: "HOLD_EXPIRED",
    });

    assert.equal(hold.status, HOLD_STATUS.RELEASED);
    assert.equal(statusOf(seatIds[0], later), "available");
  });

  test("rejects a released hold and another user's hold", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);

    assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "bob" }, T0), {
      status: 403,
      code: "HOLD_NOT_YOURS",
    });

    service.releaseHold({ holdId: hold.id, userId: "alice" });
    assertFails(() => service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0), {
      status: 409,
      code: "HOLD_RELEASED",
    });
  });
});

describe("getBooking", () => {
  test("returns the booking to its owner and 403s everyone else", () => {
    const hold = service.holdSeats({ eventId, seatIds: [seatIds[0]], userId: "alice" }, T0);
    const booking = service.confirmBooking({ holdId: hold.id, userId: "alice" }, T0);

    assert.equal(service.getBooking({ bookingId: booking.id, userId: "alice" }).id, booking.id);

    assertFails(() => service.getBooking({ bookingId: booking.id, userId: "bob" }), {
      status: 403,
      code: "BOOKING_NOT_YOURS",
    });
    assertFails(() => service.getBooking({ bookingId: "nope", userId: "alice" }), {
      status: 404,
      code: "BOOKING_NOT_FOUND",
    });
  });
});
