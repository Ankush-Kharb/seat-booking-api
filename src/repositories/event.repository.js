// Data access for events. No rules, no validation — find and store.

const COLUMNS = "id, name, venue, starts_at";

/**
 * starts_at is TIMESTAMPTZ in the database but an ISO string in the domain model and
 * in the API response, so it converts back here. node-pg hands us a JS Date; the
 * model has always carried the string form, and nothing above this line should have
 * to change because the storage type did.
 */
const toEvent = (record) => ({
  id: record.id,
  name: record.name,
  venue: record.venue,
  startsAt: record.starts_at.toISOString(),
});

/** @returns the Event, or undefined if there is no such id. */
export const findById = async (exec, eventId) => {
  const { rows } = await exec.query(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [eventId]);
  return rows.length === 0 ? undefined : toEvent(rows[0]);
};

/** Ordered explicitly: a Map iterated in insertion order, a table has no order at all. */
export const findAll = async (exec) => {
  const { rows } = await exec.query(`SELECT ${COLUMNS} FROM events ORDER BY starts_at, id`);
  return rows.map(toEvent);
};

export const insert = async (exec, event) => {
  await exec.query(
    `INSERT INTO events (id, name, venue, starts_at) VALUES ($1, $2, $3, $4)`,
    [event.id, event.name, event.venue, new Date(event.startsAt)],
  );
  return event;
};
