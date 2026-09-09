import * as bookingService from "../services/booking.service.js";
import { toHoldResponse } from "./presenters.js";

export const createHold = (req, res) => {
  const now = Date.now();
  const hold = bookingService.holdSeats(
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

export const extendHold = (req, res) => {
  const now = Date.now();
  const hold = bookingService.extendHold(
    { holdId: req.params.holdId, ttlMs: req.body.ttlMs, userId: req.userId },
    now,
  );
  res.json({ hold: toHoldResponse(hold, now) });
};

export const releaseHold = (req, res) => {
  const hold = bookingService.releaseHold({ holdId: req.params.holdId, userId: req.userId });
  res.json({ hold: toHoldResponse(hold, Date.now()) });
};
