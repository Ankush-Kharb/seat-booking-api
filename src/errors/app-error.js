// One error type for everything the API can reject, carrying the HTTP status with it.
//
// The point: services throw, and a single middleware translates. No controller
// contains a try/catch, and no service imports anything HTTP-related — it just
// happens to tag each failure with the status that fits it.

export class AppError extends Error {
  constructor(message, { status, code, details = null }) {
    super(message);          // sets `this.message`
    this.name = "AppError";
    this.status = status;    // HTTP status the middleware will send
    this.code = code;        // stable machine-readable string for clients
    this.details = details;  // optional payload, e.g. which seats were taken
  }
}

/**
 * A factory that builds error factories. Written once, it gives us four helpers
 * that differ only in their status and default code — the alternative is four
 * near-identical functions.
 *
 * Reading it inside-out: `make(404, "NOT_FOUND")` returns a *new function* that
 * remembers those two values (a closure), so `notFound("no such event")` produces
 * a 404 without repeating either.
 */
const make = (status, defaultCode) =>
  (message, { code = defaultCode, details = null } = {}) =>
    new AppError(message, { status, code, details });

export const badRequest = make(400, "BAD_REQUEST");   // malformed input
export const forbidden = make(403, "FORBIDDEN");      // not yours to touch
export const notFound = make(404, "NOT_FOUND");       // no such record
export const conflict = make(409, "CONFLICT");        // seats already taken
export const gone = make(410, "GONE");                // the hold expired
