import type pg from "pg";
import { AuditLog } from "./modules/audit/audit.js";
import { Ledger } from "./modules/ledger/ledger.js";
import type { Clock } from "./platform/clock.js";
import type { Config } from "./platform/config.js";
import type { Logger } from "./platform/logger.js";

// The composition root. Every module gets its collaborators from here.
export interface Deps {
  config: Config;
  pool: pg.Pool;
  clock: Clock;
  logger: Logger;
  ledger: Ledger;
  audit: AuditLog;
}

export function buildDeps(base: Pick<Deps, "config" | "pool" | "clock" | "logger">): Deps {
  return {
    ...base,
    ledger: new Ledger(base.clock),
    audit: new AuditLog(base.clock),
  };
}
