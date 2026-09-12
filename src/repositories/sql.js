// SQL fragments shared by more than one repository.
//
// Only things that are genuinely the same concept belong here. A fragment that two
// repositories happen to spell alike is not shared code — it is a coincidence, and
// joining them makes both harder to change.

/**
 * The seat ids belonging to a hold, in the order the client requested them.
 *
 * Two repositories need this and for the same reason: hold.seatIds and
 * booking.seatIds are the same list, read through hold_seats so that `ordinal`
 * preserves request order. They differ only in which column names the hold, hence
 * the parameter.
 *
 * `holdIdColumn` is interpolated rather than parameterised because a placeholder
 * stands for a *value*, and this is an identifier. Every caller passes a literal
 * written in this codebase — never anything derived from a request.
 */
export const seatIdsOfHold = (holdIdColumn) => `
  COALESCE(
    (SELECT array_agg(hs.seat_id ORDER BY hs.ordinal)
       FROM hold_seats hs
      WHERE hs.hold_id = ${holdIdColumn}),
    '{}'::text[]
  ) AS seat_ids`;
