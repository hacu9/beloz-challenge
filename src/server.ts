import { buildDeps } from "./deps.js";
import { buildApp } from "./http/app.js";
import { SystemClock } from "./platform/clock.js";
import { loadConfig } from "./platform/config.js";
import { createPool } from "./platform/db/pool.js";
import { createLogger } from "./platform/logger.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
const deps = buildDeps({ config, pool, clock: new SystemClock(), logger });

const server = buildApp(deps).listen(config.port, () => {
  logger.info({ port: config.port }, "listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
