// The entrypoint: migrate, seed, start listening, run the expiry sweeper.
//
// Kept separate from app.js so that tests can import the app without a port ever
// being opened. `npm start` runs this file; the tests never do.

import { createApp } from "./app.js";
import { seed } from "./seed.js";
import { migrate } from "./migrate.js";
import { closePool } from "./db.js";
import { sweepExpiredHolds } from "./services/booking.service.js";

const PORT = Number(process.env.PORT) || 3000;
const SWEEP_INTERVAL_MS = 30_000; // underscores are digit separators, as in C++14

// Boot is async now: there is a database to reach before this process can serve
// anything. Migrating on start keeps a Render deploy to one command; a larger team
// would run migrations as a separate release step instead, so that a rollback of the
// code does not silently leave the schema ahead of it.
await migrate();
await seed();

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Seat Booking API listening on http://localhost:${PORT}`);
});

// Housekeeping, not correctness — expiry already works without this. See the comment
// on sweepExpiredHolds. `.unref()` tells Node this timer must not keep the process
// alive on its own, so the server still exits cleanly on Ctrl-C.
const sweeper = setInterval(() => {
  sweepExpiredHolds(Date.now())
    .then((swept) => {
      if (swept > 0) console.log(`Swept ${swept} expired hold(s)`);
    })
    // An unhandled rejection in a timer would take the process down. A failed sweep
    // is not fatal — expiry is still correct without it — so log and carry on.
    .catch((err) => console.error("Sweep failed:", err));
}, SWEEP_INTERVAL_MS);
sweeper.unref();

// Without this, Ctrl-C kills the process mid-request. This lets in-flight requests
// finish, and closes the pool so Postgres is not left holding connections open.
const shutdown = () => {
  console.log("\nShutting down…");
  clearInterval(sweeper);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
