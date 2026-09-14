// Resolving seat status for a set of seats, in a bounded number of queries.
//
// Both services need this and neither owns it: booking.service asks "are these eight
// seats free?" before claiming them, event.service asks "what is every seat in this
// venue doing?" for the seat map. The rule itself lives in models/seatStatus; what
// lives here is how to feed it without one query per seat.

import * as holdRepo from "../repositories/hold.repository.js";
import { seatStatus } from "../models/index.js";

/**
 * Fetch every hold these seats point at, keyed by id.
 *
 * The Map version looked each one up individually, which cost a pointer dereference.
 * Doing that against a database is the N+1 query — one round trip per seat, so 201
 * queries to render a 200-seat venue. Collecting the distinct ids and fetching them
 * in one statement is the whole difference.
 */
export const loadHoldsFor = async (exec, seats) => {
  const holdIds = [...new Set(seats.map((seat) => seat.holdId).filter((id) => id !== null))];
  const holds = await holdRepo.findManyByIds(exec, holdIds);
  return new Map(holds.map((hold) => [hold.id, hold]));
};

/** A seat's status against an already-loaded holds map. */
export const statusOf = (seat, holdsById, now) =>
  seatStatus(seat, seat.holdId === null ? undefined : holdsById.get(seat.holdId), now);
