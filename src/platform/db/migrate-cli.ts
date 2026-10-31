import pg from "pg";
import { SystemClock } from "../clock.js";
import { ensureAppRole } from "./bootstrap.js";
import { migrate } from "./migrate.js";

// Usage: MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=... npm run db:migrate
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!url || !appPassword) {
    throw new Error("MIGRATION_DATABASE_URL and APP_DB_PASSWORD are required");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureAppRole(client, appPassword);
    const applied = await migrate(client, new SystemClock());
    console.log(JSON.stringify({ msg: "migrations done", applied }));
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
