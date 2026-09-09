// Demo data, so `npm start` gives you something to curl immediately.
//
// Seat ids are readable (`evt-1:A1`) rather than UUIDs purely so the examples in the
// README can be copied and pasted. Real seats would use generated ids.

import * as eventRepo from "./repositories/event.repository.js";
import * as seatRepo from "./repositories/seat.repository.js";
import { createEvent, createSeat } from "./models/index.js";

const TIERS = {
  A: { tier: "premium", priceCents: 8500 },
  B: { tier: "standard", priceCents: 4500 },
  C: { tier: "standard", priceCents: 4500 },
};

/** Build one event with `rows` × `seatsPerRow` seats. */
const seedEvent = ({ id, name, venue, startsAt, rows, seatsPerRow }) => {
  eventRepo.insert(createEvent({ id, name, venue, startsAt }));

  for (const row of rows) {
    const { tier, priceCents } = TIERS[row];
    for (let number = 1; number <= seatsPerRow; number += 1) {
      seatRepo.insert(
        createSeat({ id: `${id}:${row}${number}`, eventId: id, row, number, tier, priceCents }),
      );
    }
  }
};

export const seed = () => {
  seedEvent({
    id: "evt-1",
    name: "Arctic Monkeys — Live",
    venue: "Wembley Arena",
    startsAt: "2026-11-14T19:30:00.000Z",
    rows: ["A", "B", "C"],
    seatsPerRow: 10,
  });

  seedEvent({
    id: "evt-2",
    name: "Hamilton — Matinee",
    venue: "Victoria Palace Theatre",
    startsAt: "2026-12-02T14:00:00.000Z",
    rows: ["A", "B"],
    seatsPerRow: 6,
  });
};
