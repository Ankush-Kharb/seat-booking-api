// Read-side rules: listing events and building a seat map with live availability.
//
// Knows nothing about HTTP. Takes `now` as an argument rather than calling
// Date.now(), because "is this seat held?" is a question about a moment in time.

import * as eventRepo from "../repositories/event.repository.js";
import * as seatRepo from "../repositories/seat.repository.js";
import * as holdRepo from "../repositories/hold.repository.js";
import { seatStatus, SEAT_STATUS } from "../models/index.js";
import { notFound } from "../errors/app-error.js";
import { requireString } from "../validation.js";

export const listEvents = () => eventRepo.findAll();

/**
 * The seat map for one event, with each seat's status computed at time `now`.
 *
 * Expired holds need no cleanup to disappear from this view: a hold whose
 * expiresAt has passed simply fails `isHoldActive`, and its seat reads as
 * available again. The sweeper is housekeeping, never a correctness requirement.
 */
export const getSeatMap = (eventId, now) => {
  const id = requireString(eventId, "eventId");

  const event = eventRepo.findById(id);
  if (event === undefined) {
    throw notFound(`No event with id ${id}`, { code: "EVENT_NOT_FOUND" });
  }

  const summary = { available: 0, held: 0, sold: 0 };

  const seats = seatRepo.findByEventId(id).map((seat) => {
    // `holdId === null` means the seat was never held, so skip the lookup entirely.
    const hold = seat.holdId === null ? undefined : holdRepo.findById(seat.holdId);
    const status = seatStatus(seat, hold, now);
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
      heldUntil: status === SEAT_STATUS.HELD ? hold.expiresAt : null,
    };
  });

  return { event, seats, summary };
};
