import { buildDeps, type Deps } from "../deps.js";
import { SystemClock } from "../platform/clock.js";
import { loadConfig } from "../platform/config.js";
import { createPool } from "../platform/db/pool.js";
import { createLogger } from "../platform/logger.js";
import { expireDueHolds } from "./expire-holds.js";
import { progressClosures } from "./progress-closures.js";
import { reconcile } from "./reconcile.js";
import { seed } from "./seed.js";
import { sendDuePayouts } from "./send-payouts.js";

// Usage: node dist/jobs/cli.js <job>. Locally: `docker compose run --rm jobs <job>`.
// In AWS an EventBridge schedule runs each one as a one-off ECS task
// (infra/terraform/jobs.tf). A job that returns `ok: false` exits non-zero.
const jobs: Record<string, (deps: Deps) => Promise<object & { ok?: boolean }>> = {
  "expire-holds": (deps) => expireDueHolds(deps),
  "send-payouts": (deps) => sendDuePayouts(deps),
  "progress-closures": (deps) => progressClosures(deps),
  reconcile: (deps) => reconcile(deps),
  seed: (deps) => seed(deps),
};

async function main(): Promise<number> {
  const name = process.argv[2];
  const job = name ? jobs[name] : undefined;
  if (!job) throw new Error(`usage: cli <${Object.keys(jobs).join("|")}>`);

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl, 5);
  try {
    const result = await job(buildDeps({ config, pool, clock: new SystemClock(), logger }));
    const failed = result.ok === false;
    logger[failed ? "error" : "info"]({ job: name, result }, failed ? "job failed" : "job done");
    return failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
