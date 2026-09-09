// Data access for events. No rules, no validation — find and store.
import { db } from "../db.js";

/** @returns the Event, or undefined if there is no such id. */
export const findById = (eventId) => db.events.get(eventId);

/** `Map.values()` is a lazy iterator; `Array.from` materialises it into an array. */
export const findAll = () => Array.from(db.events.values());

export const insert = (event) => {
  db.events.set(event.id, event);
  return event;
};
