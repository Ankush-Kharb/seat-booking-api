// Data access for holds, plus maintenance of the activeHoldIds set.
import { db } from "../db.js";
import { HOLD_STATUS } from "../models/index.js";

export const findById = (holdId) => db.holds.get(holdId);

export const insert = (hold) => {
  db.holds.set(hold.id, hold);
  db.activeHoldIds.add(hold.id);

  const forUser = db.activeHoldIdsByUser.get(hold.userId);
  if (forUser === undefined) db.activeHoldIdsByUser.set(hold.userId, new Set([hold.id]));
  else forUser.add(hold.id);

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
  if (status === HOLD_STATUS.ACTIVE) return;

  db.activeHoldIds.delete(hold.id);

  const forUser = db.activeHoldIdsByUser.get(hold.userId);
  if (forUser !== undefined) {
    forUser.delete(hold.id);
    // Drop the empty Set rather than leaving one per user who ever held a seat.
    if (forUser.size === 0) db.activeHoldIdsByUser.delete(hold.userId);
  }
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

/**
 * Every hold still marked ACTIVE for one user. As with findActive, some may already
 * be past their expiry — the caller decides what counts.
 */
export const findActiveByUser = (userId) => {
  const holdIds = db.activeHoldIdsByUser.get(userId);
  if (holdIds === undefined) return [];
  return Array.from(holdIds, (holdId) => db.holds.get(holdId));
};
