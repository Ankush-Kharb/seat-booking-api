// Load test. Boots the app in-process on an ephemeral port, seeds a large event,
// and runs three scenarios with real HTTP over a keep-alive agent.
//
//   node scripts/loadtest.mjs [requests] [concurrency]
//
// requests    total requests per scenario (default 1000)
// concurrency simultaneous in-flight requests (default 0 = all at once)
//
// Note on "all at once": macOS caps the TCP accept queue at kern.ipc.somaxconn
// (128 here). Firing 1000 connections simultaneously overflows that queue and the
// kernel drops the excess — reported below as ETIMEDOUT/ECONNRESET. Those are the
// OS refusing to *establish* connections, not the API failing to *serve* them. Real
// clients and load balancers reuse a bounded connection pool, which is what the
// concurrency argument simulates.
//
// Raw `node:http` rather than fetch: it gives an explicit agent with unlimited
// sockets, so a burst is genuinely simultaneous rather than queued by a pool.

import http from "node:http";
import { createApp } from "../src/app.js";
import { resetDb } from "../src/db.js";
import * as eventRepo from "../src/repositories/event.repository.js";
import * as seatRepo from "../src/repositories/seat.repository.js";
import { createEvent, createSeat } from "../src/models/index.js";

const N = Number(process.argv[2]) || 1000;
const CONCURRENCY = Number(process.argv[3]) || 0; // 0 = unbounded burst
const EVENT_ID = "evt-load";

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

/** One request, timed. Resolves even on a transport error so the run never aborts. */
const hit = (port, method, path, body) =>
  new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const started = process.hrtime.bigint();

    const req = http.request(
      {
        port, method, path, agent,
        headers: {
          "x-user-id": `user-${Math.random().toString(36).slice(2, 8)}`,
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        },
      },
      (res) => {
        res.resume(); // drain, or sockets never free
        res.on("end", () =>
          resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 }),
        );
      },
    );

    req.on("error", (err) =>
      resolve({ status: 0, error: err.code, ms: Number(process.hrtime.bigint() - started) / 1e6 }),
    );
    if (payload) req.write(payload);
    req.end();
  });

/** Run `make(i)` N times with at most `limit` in flight. Preserves result order. */
const pool = async (count, limit, make) => {
  const results = new Array(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next;
      next += 1;
      results[i] = await make(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

const seed = (seatCount) => {
  resetDb();
  eventRepo.insert(createEvent({ id: EVENT_ID, name: "Load Test", venue: "Bench", startsAt: "2027-01-01T00:00:00.000Z" }));
  const seatIds = [];
  for (let i = 1; i <= seatCount; i += 1) {
    const id = `${EVENT_ID}:S${i}`;
    seatRepo.insert(createSeat({ id, eventId: EVENT_ID, row: "S", number: i, tier: "standard", priceCents: 1000 }));
    seatIds.push(id);
  }
  return seatIds;
};

const run = async (name, make, { expect } = {}) => {
  const started = process.hrtime.bigint();
  const results = CONCURRENCY > 0
    ? await pool(N, CONCURRENCY, make)
    : await Promise.all(Array.from({ length: N }, (unused, i) => make(i)));
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  const byStatus = new Map();
  for (const r of results) {
    const key = r.error ? `ERR ${r.error}` : r.status;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);

  console.log(`\n${name}`);
  console.log(`  ${results.length} requests in ${wallMs.toFixed(0)}ms  →  ${Math.round((results.length / wallMs) * 1000).toLocaleString()} req/s`);
  console.log(`  latency  p50 ${percentile(sorted, 50).toFixed(1)}ms   p95 ${percentile(sorted, 95).toFixed(1)}ms   p99 ${percentile(sorted, 99).toFixed(1)}ms   max ${sorted.at(-1).toFixed(1)}ms`);
  console.log(`  statuses ${[...byStatus.entries()].map(([k, v]) => `${k}×${v}`).join("  ")}`);

  if (expect) {
    const actual = Object.fromEntries(byStatus);
    const ok = Object.entries(expect).every(([k, v]) => actual[k] === v);
    console.log(`  ${ok ? "PASS" : "FAIL"}  expected ${JSON.stringify(expect)}`);
    if (!ok) process.exitCode = 1;
  }
  return { wallMs, results };
};

// ---------------------------------------------------------------------------
const app = createApp();
const server = app.listen(0, "127.0.0.1", 2048); // backlog, capped by kern.ipc.somaxconn
await new Promise((r) => server.once("listening", r));
const { port } = server.address();
const mode = CONCURRENCY > 0 ? `${CONCURRENCY} concurrent` : "all at once (unbounded burst)";
console.log(`Load test — ${N} requests per scenario, ${mode}, port ${port}\n${"─".repeat(64)}`);

// 1. Maximum contention: every request wants the same seat.
seed(10);
await run(
  `1. CONTENTION — ${N} simultaneous holds, all for one seat`,
  () => hit(port, "POST", "/holds", { eventId: EVENT_ID, seatIds: [`${EVENT_ID}:S1`] }),
  { 201: 1, 409: N - 1 },
);

// 2. No contention: one request per seat, all at once.
const seatIds = seed(N);
await run(
  `2. THROUGHPUT — ${N} simultaneous holds, one per distinct seat`,
  (i) => hit(port, "POST", "/holds", { eventId: EVENT_ID, seatIds: [seatIds[i]] }),
  { 201: N },
);

// 3. Reads against a fixed-size venue. Seat count is held constant at 200 so this
// measures request throughput rather than payload growth — every seat is held, so
// each request does 200 hold lookups plus a 200-seat JSON serialisation.
const READ_SEATS = 200;
const readSeatIds = seed(READ_SEATS);
for (const id of readSeatIds) {
  await hit(port, "POST", "/holds", { eventId: EVENT_ID, seatIds: [id] });
}
await run(
  `3. READS — ${N} seat-map requests (${READ_SEATS} seats, all held)`,
  () => hit(port, "GET", `/events/${EVENT_ID}/seats`),
  { 200: N },
);

const mem = process.memoryUsage();
console.log(`\n${"─".repeat(64)}`);
console.log(`heap in use: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB   rss: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
console.log(`(${N} seats, ${N} holds retained in memory)`);

server.close();
agent.destroy();
