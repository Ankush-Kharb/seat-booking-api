// Data access for holds, plus maintenance of the activeHoldIds set.
import { db } from "../db.js";
import { HOLD_STATUS } from "../models/index.js";

export const findById = (holdId) => db.holds.get(holdId);

export const insert = (hold) => {
  db.holds.set(hold.id, hold);
  db.activeHoldIds.add(hold.id);
  return hold;
};

/**
 * Change a hold's status and keep `activeHoldIds` in step.
 *
 * Only ACTIVE holds belong in the set, so any move away from ACTIVE removes the id.
 * Holds are never resurrected — RELEASED and CONFIRMED are terminal.
 */
export const setStatus = (hold, status) => {
  hold.status = status;
  if (status !== HOLD_STATUS.ACTIVE) db.activeHoldIds.delete(hold.id);
};

export const setExpiry = (hold, expiresAt) => {
  hold.expiresAt = expiresAt;
};

/**
 * Every hold still marked ACTIVE. Some of them may already be past their expiry —
 * deciding that is the service's job, not ours.
 *
 * Returns a fresh array rather than the live Set, because the caller will be
 * removing entries from that Set while iterating.
 */
export const findActive = () =>
  Array.from(db.activeHoldIds, (holdId) => db.holds.get(holdId));
