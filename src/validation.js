// Input validation shared by the services.
//
// Validation lives at the service boundary, not in the controllers, for one reason:
// the tests call services directly. If the checks lived in controllers, every rule
// would be untested unless the request happened to go over HTTP — and any future
// caller (a CLI, a queue consumer) would bypass them entirely.

import { badRequest } from "./errors/app-error.js";

export const requireString = (value, field) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`"${field}" must be a non-empty string`, { details: { field } });
  }
  return value.trim();
};

/**
 * Optional integer with a default and inclusive bounds.
 *
 * `Number.isInteger` is the safe test: `typeof NaN` is "number", and so is 1.5.
 */
export const optionalInt = (value, field, { fallback, min, max }) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) {
    throw badRequest(`"${field}" must be an integer`, { details: { field } });
  }
  if (value < min || value > max) {
    throw badRequest(`"${field}" must be between ${min} and ${max}`, {
      details: { field, min, max, received: value },
    });
  }
  return value;
};

/**
 * A non-empty array of unique, non-empty strings — returned deduplicated so the
 * caller never has to think about `["A1", "A1"]`.
 */
export const requireIdList = (value, field, { maxLength }) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`"${field}" must be a non-empty array`, { details: { field } });
  }
  if (value.length > maxLength) {
    throw badRequest(`"${field}" may contain at most ${maxLength} entries`, {
      details: { field, maxLength, received: value.length },
    });
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw badRequest(`"${field}" must contain only non-empty strings`, { details: { field } });
    }
  }
  // A Set keeps insertion order and drops duplicates in one pass.
  return Array.from(new Set(value.map((entry) => entry.trim())));
};
