import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import * as controller from "../controllers/holds.controller.js";

export const holdsRouter = Router();

// Applied to every route in this router, so no individual route repeats it.
holdsRouter.use(authenticate);

holdsRouter.post("/", controller.createHold);
holdsRouter.post("/:holdId/extend", controller.extendHold);
holdsRouter.delete("/:holdId", controller.releaseHold);
