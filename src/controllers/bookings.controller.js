import * as bookingService from "../services/booking.service.js";
import { toBookingResponse } from "./presenters.js";

export const createBooking = async (req, res) => {
  const booking = await bookingService.confirmBooking(
    { holdId: req.body.holdId, userId: req.userId },
    Date.now(),
  );
  // 201 on the first confirm and on an idempotent replay alike: the client's view is
  // identical either way, and it has no way to tell which one it got. That is the point.
  res.status(201).json({ booking: toBookingResponse(booking) });
};

export const getBooking = async (req, res) => {
  const booking = await bookingService.getBooking({
    bookingId: req.params.bookingId,
    userId: req.userId,
  });
  res.json({ booking: toBookingResponse(booking) });
};
