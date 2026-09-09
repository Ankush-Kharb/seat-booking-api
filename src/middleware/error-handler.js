// The single place where an error becomes an HTTP response.
//
// Express recognises a middleware as an error handler purely by its arity: four
// parameters. `next` is unused but must be declared, or Express treats this as an
// ordinary middleware and never calls it.

import { AppError } from "../errors/app-error.js";

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: `Cannot ${req.method} ${req.originalUrl}` },
  });
};

export const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // A malformed JSON body is thrown by express.json() before any of our code runs.
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON", details: null },
    });
  }

  // Anything else is a bug in this codebase. Log it in full, tell the client nothing —
  // stack traces and internal messages are an information leak.
  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong", details: null },
  });
};
