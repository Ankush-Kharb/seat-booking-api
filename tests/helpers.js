// Shared test setup.
//
// T0 is a fixed, arbitrary instant. Tests never use the real clock — they pass T0,
// or T0 + some offset, so a test that exercises a two-minute expiry runs instantly
// and produces the same result on every machine, forever.

import { resetDb } from "../src/db.js";
import * as eventRepo from "../src/repositories/event.repository.js";
import * as seatRepo from "../src/repositories/seat.repository.js";
import { createEvent, createSeat } from "../src/models/index.js";

export const T0 = 1_700_000_000_000;
export const MINUTE = 60_000;

export const seedTestEvent = ({ eventId = "evt-test", seatCount = 5, priceCents = 1000 } = {}) => {
  eventRepo.insert(
    createEvent({ id: eventId, name: "Test Event", venue: "Test Venue", startsAt: "2026-11-01T19:00:00.000Z" }),
  );

  const seatIds = [];
  for (let number = 1; number <= seatCount; number += 1) {
    const id = `${eventId}:A${number}`;
    seatRepo.insert(createSeat({ id, eventId, row: "A", number, tier: "standard", priceCents }));
    seatIds.push(id);
  }
  return { eventId, seatIds };
};

/** Wipe the database and seed one event. Call at the start of every test. */
export const freshDb = (options) => {
  resetDb();
  return seedTestEvent(options);
};
