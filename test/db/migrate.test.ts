import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock.js";
import { MIGRATIONS_DIR, migrate } from "../../src/platform/db/migrate.js";
import { ISOLATED_OWNER_URL } from "../support/env.js";

// Runs against the isolated copy: it is fully migrated and has no traffic.
async function migrateWith(extra: Record<string, string>): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "acme-migrations-"));
  for (const f of readdirSync(MIGRATIONS_DIR))
    copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(path.join(dir, name), sql);
  const client = new pg.Client({ connectionString: ISOLATED_OWNER_URL });
  await client.connect();
  try {
    return await migrate(client, new FixedClock("2026-11-01T00:00:00Z"), dir);
  } finally {
    await client.end();
  }
}

describe("migrations", () => {
  it("a fully migrated database applies nothing on a second run", async () => {
    expect(await migrateWith({})).toEqual([]);
  });

  it("review D4: refuses a new migration that sorts before an applied one", async () => {
    await expect(migrateWith({ "000_late.sql": "SELECT 1;" })).rejects.toThrow(
      /000_late\.sql sorts before the applied/,
    );
  });

  it("refuses an applied migration whose file changed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acme-migrations-"));
    for (const f of readdirSync(MIGRATIONS_DIR))
      copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    writeFileSync(path.join(dir, "002_accounts_and_deposits.sql"), "-- edited\n");
    const client = new pg.Client({ connectionString: ISOLATED_OWNER_URL });
    await client.connect();
    try {
      await expect(migrate(client, new FixedClock("2026-11-01T00:00:00Z"), dir)).rejects.toThrow(
        /002_accounts_and_deposits\.sql changed after it was applied/,
      );
    } finally {
      await client.end();
    }
  });
});
