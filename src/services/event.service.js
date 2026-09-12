// Read-side rules: listing events and building a seat map with live availability.
//
// Knows nothing about HTTP. Takes `now` as an argument rather than calling
// Date.now(), because "is this seat held?" is a question about a moment in time.

import { pool } from "../db.js";
import * as eventRepo from "../repositories/event.repository.js";
import * as seatRepo from "../repositories/seat.repository.js";
import { loadHoldsFor, statusOf } from "./seat-availability.js";
import { SEAT_STATUS } from "../models/index.js";
import { notFound } from "../errors/app-error.js";
import { requireString } from "../validation.js";

// Reads take the pool directly: each query commits on its own, and nothing here
// decides anything it then writes, so there is no invariant a transaction would protect.
export const listEvents = () => eventRepo.findAll(pool);

/**
 * The seat map for one event, with each seat's status computed at time `now`.
 *
 * Expired holds need no cleanup to disappear from this view: a hold whose expiresAt
 * has passed simply fails isHoldActive, and its seat reads as available again. The
 * sweeper is housekeeping, never a correctness requirement.
 */
export const getSeatMap = async (eventId, now) => {
  const id = requireString(eventId, "eventId");

  const event = await eventRepo.findById(pool, id);
  if (event === undefined) {
    throw notFound(`No event with id ${id}`, { code: "EVENT_NOT_FOUND" });
  }

  const seats = await seatRepo.findByEventId(pool, id);

  // One query for every hold these seats point at, rather than one per seat. See
  // loadHoldsFor — on a 200-seat venue the naive version is 201 queries for one page.
  const holdsById = await loadHoldsFor(pool, seats);

  const summary = { available: 0, held: 0, sold: 0 };

  const rows = seats.map((seat) => {
    const status = statusOf(seat, holdsById, now);
    summary[status] += 1;

    return {
      id: seat.id,
      label: seat.label,
      row: seat.row,
      number: seat.number,
      tier: seat.tier,
      priceCents: seat.priceCents,
      status,
      // Only surface the expiry of a hold that is genuinely live.
      heldUntil: status === SEAT_STATUS.HELD ? holdsById.get(seat.holdId).expiresAt : null,
    };
  });

  return { event, seats: rows, summary };
};
