// The entrypoint: seed data, start listening, run the expiry sweeper.
//
// Kept separate from app.js so that tests can import the app without a port ever
// being opened. `npm start` runs this file; the tests never do.

import { createApp } from "./app.js";
import { seed } from "./seed.js";
import { sweepExpiredHolds } from "./services/booking.service.js";

const PORT = Number(process.env.PORT) || 3000;
const SWEEP_INTERVAL_MS = 30_000; // underscores are digit separators, as in C++14

seed();

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Seat Booking API listening on http://localhost:${PORT}`);
});

// Housekeeping, not correctness — expiry already works without this. See the comment
// on sweepExpiredHolds. `.unref()` tells Node this timer must not keep the process
// alive on its own, so the server still exits cleanly on Ctrl-C.
const sweeper = setInterval(() => {
  const swept = sweepExpiredHolds(Date.now());
  if (swept > 0) console.log(`Swept ${swept} expired hold(s)`);
}, SWEEP_INTERVAL_MS);
sweeper.unref();

// Without this, Ctrl-C kills the process mid-request. This lets in-flight requests finish.
const shutdown = () => {
  console.log("\nShutting down…");
  clearInterval(sweeper);
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
