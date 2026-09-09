// A Router is a mini-app: a group of routes that app.js mounts under a path prefix.
// Reading events needs no identity, so `authenticate` is not applied here.
import { Router } from "express";
import * as controller from "../controllers/events.controller.js";

export const eventsRouter = Router();

eventsRouter.get("/", controller.listEvents);
eventsRouter.get("/:eventId/seats", controller.getSeatMap);
