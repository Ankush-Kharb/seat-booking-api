// Controllers are deliberately thin: read the request, call a service, send JSON.
//
// No try/catch anywhere. A service throws an AppError, Express 5 catches it — from a
// rejected promise as readily as from a synchronous throw — and routes it to the
// error middleware, which owns the status code.

import * as eventService from "../services/event.service.js";

export const listEvents = async (req, res) => {
  res.json({ events: await eventService.listEvents() });
};

export const getSeatMap = async (req, res) => {
  // Date.now() is called HERE, at the system's edge, and passed down. Everything
  // below this line takes time as an argument, which is what makes it testable.
  const { event, seats, summary } = await eventService.getSeatMap(
    req.params.eventId,
    Date.now(),
  );
  res.json({ event, summary, seats });
};
