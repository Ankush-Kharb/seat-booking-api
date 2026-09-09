import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import * as controller from "../controllers/bookings.controller.js";

export const bookingsRouter = Router();

bookingsRouter.use(authenticate);

bookingsRouter.post("/", controller.createBooking);
bookingsRouter.get("/:bookingId", controller.getBooking);
