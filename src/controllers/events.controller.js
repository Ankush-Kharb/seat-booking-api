// Controllers are deliberately thin: read the request, call a service, send JSON.
//
// No try/catch anywhere. A service throws an AppError, Express catches it and routes
// it to the error middleware, which owns the status code. Adding a try/catch here
// would duplicate that mapping in every handler.

import * as eventService from "../services/event.service.js";

export const listEvents = (req, res) => {
  res.json({ events: eventService.listEvents() });
};

export const getSeatMap = (req, res) => {
  // Date.now() is called HERE, at the system's edge, and passed down. Everything
  // below this line takes time as an argument, which is what makes it testable.
  const { event, seats, summary } = eventService.getSeatMap(req.params.eventId, Date.now());
  res.json({ event, summary, seats });
};
