// Shaping domain records into JSON responses.
//
// Kept apart from the controllers so that the hold shape is defined once and used
// by both "create hold" and "extend hold", which would otherwise drift apart.

export const toHoldResponse = (hold, now) => ({
  id: hold.id,
  eventId: hold.eventId,
  seatIds: hold.seatIds,
  status: hold.status,
  expiresAt: new Date(hold.expiresAt).toISOString(),
  // The genuinely useful field for a client counting down a timer.
  expiresInMs: Math.max(0, hold.expiresAt - now),
});

export const toBookingResponse = (booking) => ({
  id: booking.id,
  eventId: booking.eventId,
  holdId: booking.holdId,
  seatIds: booking.seatIds,
  totalCents: booking.totalCents,
  createdAt: new Date(booking.createdAt).toISOString(),
});
