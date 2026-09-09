// Wiring only. This file creates the Express app and decides the order things run in.
// It holds no state and no rules, which is why the tests can build a fresh app per file.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { eventsRouter } from "./routes/events.routes.js";
import { holdsRouter } from "./routes/holds.routes.js";
import { bookingsRouter } from "./routes/bookings.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export const createApp = () => {
  const app = express();

  // Order is not cosmetic — Express runs these top to bottom for every request.
  app.use(express.json({ limit: "16kb" })); // parses a JSON body into req.body

  // The browser console at "/". Static files are served before the routers so a
  // request for "/" never reaches notFoundHandler. `import.meta.url` is the ESM
  // replacement for CommonJS __dirname, which does not exist in a module.
  const here = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(join(here, "..", "public")));

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.use("/events", eventsRouter);
  app.use("/holds", holdsRouter);
  app.use("/bookings", bookingsRouter);

  // These two go last. notFoundHandler catches any request no router claimed;
  // errorHandler has four parameters, so Express only reaches it via next(err).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
