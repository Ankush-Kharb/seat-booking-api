// HTTP-level tests. supertest starts the app on an ephemeral port, makes a real
// request, and shuts it down — so status codes, headers, and JSON shapes are all
// exercised exactly as a client would meet them.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { freshDb } from "./helpers.js";
import { createApp } from "../src/app.js";

const app = createApp(); // stateless — the database is what gets reset between tests

let eventId;
let seatIds;

beforeEach(() => {
  ({ eventId, seatIds } = freshDb({ seatCount: 5, priceCents: 1500 }));
});

const holdSeats = (userId, body) =>
  request(app).post("/holds").set("x-user-id", userId).send(body);

describe("reads", () => {
  test("GET /health", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  test("GET /events lists events", async () => {
    const res = await request(app).get("/events");
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].id, eventId);
  });

  test("GET /events/:id/seats returns a seat map with a summary", async () => {
    const res = await request(app).get(`/events/${eventId}/seats`);
    assert.equal(res.status, 200);
    assert.equal(res.body.seats.length, 5);
    assert.deepEqual(res.body.summary, { available: 5, held: 0, sold: 0 });
    assert.equal(res.body.seats[0].heldUntil, null);
  });

  test("GET /events/:id/seats 404s for an unknown event", async () => {
    const res = await request(app).get("/events/ghost/seats");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "EVENT_NOT_FOUND");
  });
});

describe("auth and input handling", () => {
  test("400 without an x-user-id header", async () => {
    const res = await request(app).post("/holds").send({ eventId, seatIds: [seatIds[0]] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "MISSING_USER");
  });

  test("400 on malformed JSON", async () => {
    const res = await request(app)
      .post("/holds")
      .set("x-user-id", "alice")
      .set("content-type", "application/json")
      .send("{not json");

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "MALFORMED_JSON");
  });

  test("404 with a JSON body on an unknown route", async () => {
    const res = await request(app).get("/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "ROUTE_NOT_FOUND");
  });
});

describe("the booking flow", () => {
  test("hold, extend, confirm, fetch", async () => {
    const held = await holdSeats("alice", { eventId, seatIds: [seatIds[0], seatIds[1]] });
    assert.equal(held.status, 201);
    assert.equal(held.body.hold.seatIds.length, 2);
    assert.ok(held.body.hold.expiresInMs > 0);
    assert.ok(Date.parse(held.body.hold.expiresAt) > 0); // ISO string, not a raw number

    const holdId = held.body.hold.id;

    const seatMap = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(seatMap.body.summary, { available: 3, held: 2, sold: 0 });

    const extended = await request(app)
      .post(`/holds/${holdId}/extend`)
      .set("x-user-id", "alice")
      .send({ ttlMs: 300_000 });
    assert.equal(extended.status, 200);
    assert.ok(extended.body.hold.expiresInMs > held.body.hold.expiresInMs);

    const booked = await request(app)
      .post("/bookings")
      .set("x-user-id", "alice")
      .send({ holdId });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.booking.totalCents, 3000);

    const fetched = await request(app)
      .get(`/bookings/${booked.body.booking.id}`)
      .set("x-user-id", "alice");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.booking.id, booked.body.booking.id);

    const sold = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(sold.body.summary, { available: 3, held: 0, sold: 2 });
  });

  test("releasing a hold puts the seats straight back", async () => {
    const held = await holdSeats("alice", { eventId, seatIds: [seatIds[0]] });

    const released = await request(app)
      .delete(`/holds/${held.body.hold.id}`)
      .set("x-user-id", "alice");
    assert.equal(released.status, 200);
    assert.equal(released.body.hold.status, "released");

    const map = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(map.body.summary, { available: 5, held: 0, sold: 0 });
  });

  test("confirming twice returns the same booking, not two", async () => {
    const held = await holdSeats("alice", { eventId, seatIds: [seatIds[0]] });
    const body = { holdId: held.body.hold.id };

    const first = await request(app).post("/bookings").set("x-user-id", "alice").send(body);
    const second = await request(app).post("/bookings").set("x-user-id", "alice").send(body);

    assert.equal(first.body.booking.id, second.body.booking.id);
    assert.equal(second.status, 201);
  });

  test("409 when a requested seat is already held, naming the seat", async () => {
    await holdSeats("alice", { eventId, seatIds: [seatIds[1]] });

    const res = await holdSeats("bob", { eventId, seatIds: [seatIds[0], seatIds[1]] });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SEATS_UNAVAILABLE");
    assert.deepEqual(res.body.error.details.unavailable, [
      { seatId: seatIds[1], label: "A2", status: "held" },
    ]);

    // And bob's failed attempt left seat A1 untouched.
    const map = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(map.body.summary, { available: 4, held: 1, sold: 0 });
  });

  test("403 when touching someone else's hold", async () => {
    const held = await holdSeats("alice", { eventId, seatIds: [seatIds[0]] });
    const holdId = held.body.hold.id;

    const stolen = await request(app).post("/bookings").set("x-user-id", "bob").send({ holdId });
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.error.code, "HOLD_NOT_YOURS");

    const deleted = await request(app).delete(`/holds/${holdId}`).set("x-user-id", "bob");
    assert.equal(deleted.status, 403);
  });
});

describe("concurrency", () => {
  test("20 simultaneous requests for one seat produce exactly one hold", async () => {
    // Promise.all fires all 20 requests before awaiting any of them, so they are
    // genuinely in flight together and arrive interleaved at the server.
    //
    // Exactly one may win. The others must fail with 409 — never 500, and never a
    // second successful hold on the same seat.
    const attempts = Array.from({ length: 20 }, (unused, i) =>
      holdSeats(`user-${i}`, { eventId, seatIds: [seatIds[0]] }),
    );

    const results = await Promise.all(attempts);

    const created = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status === 409);

    assert.equal(created.length, 1, "exactly one request should win the seat");
    assert.equal(rejected.length, 19, "every other request should get a clean 409");

    for (const res of rejected) {
      assert.equal(res.body.error.code, "SEATS_UNAVAILABLE");
    }

    const map = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(map.body.summary, { available: 4, held: 1, sold: 0 });
  });

  test("two users racing for overlapping seat ranges never double-book", async () => {
    // alice wants A1-A3, bob wants A3-A5. They collide on A3, so exactly one of them
    // gets their whole set and the other gets nothing.
    const [aliceRes, bobRes] = await Promise.all([
      holdSeats("alice", { eventId, seatIds: [seatIds[0], seatIds[1], seatIds[2]] }),
      holdSeats("bob", { eventId, seatIds: [seatIds[2], seatIds[3], seatIds[4]] }),
    ]);

    const winners = [aliceRes, bobRes].filter((res) => res.status === 201);
    assert.equal(winners.length, 1);

    const map = await request(app).get(`/events/${eventId}/seats`);
    assert.deepEqual(map.body.summary, { available: 2, held: 3, sold: 0 });
  });
});
