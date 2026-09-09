// Stand-in for authentication.
//
// A real API would verify a JWT or a session cookie here and attach the verified
// identity. This project reads an `x-user-id` header and trusts it — which is fine
// for a demo and is clearly labelled as such, but must not be mistaken for auth.
//
// The value of putting it in middleware rather than in each controller: ownership
// checks downstream read one field, `req.userId`, and no controller repeats the
// header name.

import { badRequest } from "../errors/app-error.js";

export const authenticate = (req, res, next) => {
  const userId = req.get("x-user-id");

  if (userId === undefined || userId.trim() === "") {
    // `next(err)` hands control to the error middleware. Calling `next()` with an
    // argument means "stop the normal chain"; calling it with none means "carry on".
    return next(
      badRequest("Missing x-user-id header", { code: "MISSING_USER" }),
    );
  }

  req.userId = userId.trim();
  return next();
};
