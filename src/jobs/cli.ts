import { buildDeps } from "../deps.js";
import { SystemClock } from "../platform/clock.js";
import { loadConfig } from "../platform/config.js";
import { createPool } from "../platform/db/pool.js";
import { createLogger } from "../platform/logger.js";
import { expireDueHolds } from "./expire-holds.js";

// Usage: node dist/jobs/cli.js <job>. In AWS an EventBridge schedule runs it
// as a one-off ECS task (architecture §12).
const jobs = { "expire-holds": expireDueHolds } as const;

async function main(): Promise<void> {
  const name = process.argv[2] as keyof typeof jobs | undefined;
  const job = name ? jobs[name] : undefined;
  if (!job) throw new Error(`usage: cli <${Object.keys(jobs).join("|")}>`);

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl, 5);
  try {
    const result = await job(buildDeps({ config, pool, clock: new SystemClock(), logger }));
    logger.info({ job: name, result }, "job done");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
