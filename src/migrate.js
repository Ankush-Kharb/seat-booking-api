// Migration runner. `npm run migrate` applies every file in migrations/ that has
// not run yet, in filename order.
//
// Deliberately about thirty lines rather than a dependency. All it needs to do is
// remember which files it has already applied, and refuse to apply one twice.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pool, closePool } from "./db.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export const migrate = async () => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.filename));

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = await readFile(join(migrationsDir, filename), "utf8");
    // Each migration file opens its own BEGIN/COMMIT, so the bookkeeping INSERT goes
    // in its own statement afterwards. If the migration throws, nothing is recorded
    // and the next run retries it.
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    console.log(`applied ${filename}`);
  }
};

// Run only when invoked directly (`node src/migrate.js`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(closePool)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
