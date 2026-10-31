import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { Writable } from "node:stream";
import { buildDeps, type Deps } from "../../src/deps.js";
import { buildApp, type AppOptions } from "../../src/http/app.js";
import { FixedClock } from "../../src/platform/clock.js";
import type { Config } from "../../src/platform/config.js";
import { createPool, type Pool } from "../../src/platform/db/pool.js";
import { createLogger } from "../../src/platform/logger.js";
import { APP_URL, OWNER_URL } from "./env.js";

export const testConfig: Config = {
  port: 0,
  logLevel: "silent",
  databaseUrl: APP_URL,
  jwtSecret: "test-jwt-secret-0123456789abcdef0123456789",
  networkApiKey: "test-network-key-0123456789",
  bankWebhookSecret: "test-bank-webhook-secret-0123456789abcdef",
  bankSignatureToleranceSeconds: 300,
  holdTtlDays: 7,
  closingCaptureWindowDays: 30,
  minDepositCentavos: 50_000,
  maxAmountCentavos: 100_000_000,
};

export interface Harness {
  deps: Deps;
  clock: FixedClock;
  /** Connects as acme_app, like the service. */
  pool: Pool;
  /** Connects as the table owner, to test the triggers without the grants. */
  ownerPool: Pool;
  logLines: Record<string, unknown>[];
  app(opts?: AppOptions): Express;
  close(): Promise<void>;
}

export function createHarness(): Harness {
  const clock = new FixedClock("2026-11-01T12:00:00Z");
  const logLines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  const pool = createPool(APP_URL, 40);
  const ownerPool = createPool(OWNER_URL, 5);
  const deps = buildDeps({ config: testConfig, pool, clock, logger: createLogger("info", sink) });
  return {
    deps,
    clock,
    pool,
    ownerPool,
    logLines,
    app: (opts) => buildApp(deps, opts),
    close: async () => {
      await pool.end();
      await ownerPool.end();
    },
  };
}

/** Starts a real HTTP server, for tests that need true parallel requests. */
export async function listen(app: Express): Promise<{ url: string; close(): Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
