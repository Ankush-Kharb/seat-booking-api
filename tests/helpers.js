// Shared test setup.
//
// T0 is a fixed, arbitrary instant. Tests never use the real clock — they pass T0,
// or T0 + some offset, so a test that exercises a two-minute expiry runs instantly
// and produces the same result on every machine, forever. Moving to Postgres changed
// nothing about that: `now` is still a plain number the repositories convert at the
// boundary.
//
// Requires a database. Start one with `docker compose up -d` and set DATABASE_URL.

import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import * as eventRepo from "../src/repositories/event.repository.js";
import * as seatRepo from "../src/repositories/seat.repository.js";
import { createEvent, createSeat } from "../src/models/index.js";

export const T0 = 1_700_000_000_000;
export const MINUTE = 60_000;

// Applied once per test process, not once per test. `??=` assigns only if the left
// side is null or undefined, so every later call awaits the same promise.
let schemaReady;

/**
 * Wipe every table.
 *
 * TRUNCATE rather than DELETE: it does not scan the rows, and one statement covering
 * all five tables sidesteps the foreign keys between them — there is no order in
 * which DELETE would work without CASCADE anyway.
 *
 * schema_migrations is deliberately absent, or every test would re-run the migrations.
 */
export const resetDb = () =>
  pool.query("TRUNCATE hold_seats, bookings, holds, seats, events CASCADE");

export const seedTestEvent = async ({
  eventId = "evt-test",
  seatCount = 5,
  priceCents = 1000,
} = {}) => {
  await eventRepo.insert(
    pool,
    createEvent({
      id: eventId,
      name: "Test Event",
      venue: "Test Venue",
      startsAt: "2026-11-01T19:00:00.000Z",
    }),
  );

  const seats = [];
  for (let number = 1; number <= seatCount; number += 1) {
    seats.push(
      createSeat({
        id: `${eventId}:A${number}`,
        eventId,
        row: "A",
        number,
        tier: "standard",
        priceCents,
      }),
    );
  }
  await seatRepo.insertMany(pool, seats);

  return { eventId, seatIds: seats.map((seat) => seat.id) };
};

/** Wipe the database and seed one event. Call at the start of every test. */
export const freshDb = async (options) => {
  schemaReady ??= migrate();
  await schemaReady;
  await resetDb();
  return seedTestEvent(options);
};
