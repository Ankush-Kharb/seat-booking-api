// The Postgres connection pool and the transaction helper.
//
// Replaces src/db.js at cutover. The same rule carries over unchanged: this is the
// only file that owns storage, and nothing above the repository layer may import it.
//
// What is new is the thing the Maps never needed — a connection. A Map lookup was a
// pointer dereference. A query is a round trip over a socket, so every call becomes
// async, and several requests are genuinely in flight at once. That concurrency is
// the whole reason the check/commit split in booking.service.js stops being safe on
// its own.

import pg from "pg";

const { Pool } = pg;

/**
 * A pool, not a connection. Opening a Postgres connection is expensive (a process
 * on the server side), so we keep a small fixed set and hand them out per query.
 *
 * `max` is a real ceiling on concurrency: with max 10, an eleventh simultaneous
 * request waits for a connection to come free. Setting it high does not make the
 * database faster — it makes contention worse.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

/**
 * Run `fn` inside one transaction, handing it the client to use.
 *
 * Every repository function takes an "executor" as its first argument. It is either
 * `pool` — each query commits on its own — or the client passed here, in which case
 * every query joins this transaction. Both expose `.query()`, so a repository
 * function does not know or care which it got. That duck typing is standing in for
 * what you would express in C++ as taking a reference to an abstract base.
 *
 * The `finally` is the important line, and it is exactly RAII: `release()` is the
 * destructor that returns the connection to the pool. Miss it on an error path and
 * you leak one connection per failed request, until `max` is reached and the whole
 * app wedges waiting for a connection that is never coming back.
 */
export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // ROLLBACK can itself throw if the connection died mid-transaction. Swallow that
    // one, because the caller needs the original error, not the cleanup's.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is gone; releasing it below is all that is left to do */
    }
    throw error;
  } finally {
    client.release();
  }
};

/** Close the pool. Tests and a clean shutdown need this or the process will not exit. */
export const closePool = () => pool.end();
