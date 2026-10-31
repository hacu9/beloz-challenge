import pg from "pg";
import { FixedClock } from "../src/platform/clock.js";
import { ensureAppRole } from "../src/platform/db/bootstrap.js";
import { migrate } from "../src/platform/db/migrate.js";
import { ADMIN_URL, APP_PASSWORD, OWNER_URL, TEST_DB } from "./support/env.js";

// A fresh database per test run, migrated exactly like production. The ledger
// cannot be truncated (LEDGER-04), so the tests never reset it: each test
// creates its own data and checks only that data, plus global invariants.
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await ensureAppRole(admin, APP_PASSWORD);
  } finally {
    await admin.end();
  }

  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await migrate(owner, new FixedClock("2026-11-01T00:00:00Z"));
  } finally {
    await owner.end();
  }
}
