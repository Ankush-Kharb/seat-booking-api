import * as bookingService from "../services/booking.service.js";
import { toHoldResponse } from "./presenters.js";

// Handlers are async now, and still contain no try/catch. Express 5 forwards a
// rejected promise from a handler to the error middleware by itself — in Express 4
// this would have needed a wrapper around every handler, or an unhandled rejection
// would have hung the request until it timed out.

export const createHold = async (req, res) => {
  const now = Date.now();
  const hold = await bookingService.holdSeats(
    {
      eventId: req.body.eventId,
      seatIds: req.body.seatIds,
      ttlMs: req.body.ttlMs,
      userId: req.userId, // set by the authenticate middleware
    },
    now,
  );
  res.status(201).json({ hold: toHoldResponse(hold, now) });
};

export const extendHold = async (req, res) => {
  const now = Date.now();
  const hold = await bookingService.extendHold(
    { holdId: req.params.holdId, ttlMs: req.body.ttlMs, userId: req.userId },
    now,
  );
  res.json({ hold: toHoldResponse(hold, now) });
};

export const releaseHold = async (req, res) => {
  const hold = await bookingService.releaseHold({
    holdId: req.params.holdId,
    userId: req.userId,
  });
  res.json({ hold: toHoldResponse(hold, Date.now()) });
};
