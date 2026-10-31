import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { Clock } from "../clock.js";

// src/platform/db and dist/platform/db are both three levels below the repo root.
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);

const LOCK_KEY = 4_242_001;

// Applies numbered SQL files in order, one transaction per file. A checksum
// catches an applied migration that someone edited afterwards.
export async function migrate(
  owner: pg.ClientBase,
  clock: Clock,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  await owner.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await owner.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)`);
    const { rows } = await owner.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    // A migration added before one that already ran would run out of order
    // (review D4): refuse it instead of applying it after its successors.
    const lastApplied = [...done.keys()].sort().at(-1);
    const late = files.filter((f) => !done.has(f) && lastApplied !== undefined && f < lastApplied);
    if (late.length > 0) {
      throw new Error(
        `migration ${late.join(", ")} sorts before the applied ${lastApplied}; rename it to run last`,
      );
    }

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`migration ${file} changed after it was applied`);
        }
        continue;
      }
      await owner.query("BEGIN");
      try {
        await owner.query(sql);
        await owner.query(
          "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)",
          [file, checksum, clock.now()],
        );
        await owner.query("COMMIT");
      } catch (err) {
        await owner.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    await owner.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
  return applied;
}
