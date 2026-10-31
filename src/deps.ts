import type pg from "pg";
import { Accounts } from "./modules/accounts/accounts.js";
import { AuditLog } from "./modules/audit/audit.js";
import { Deposits } from "./modules/collateral/deposits.js";
import { Ledger } from "./modules/ledger/ledger.js";
import { Authorizations } from "./modules/spending/authorizations.js";
import { Clearing } from "./modules/spending/clearing.js";
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
  accounts: Accounts;
  deposits: Deposits;
  authorizations: Authorizations;
  clearing: Clearing;
}

export function buildDeps(base: Pick<Deps, "config" | "pool" | "clock" | "logger">): Deps {
  const ledger = new Ledger(base.clock);
  const audit = new AuditLog(base.clock);
  const accounts = new Accounts(base.clock, ledger, audit);
  const deposits = new Deposits(
    base.clock,
    ledger,
    audit,
    accounts,
    base.config.minDepositCentavos,
  );
  const authorizations = new Authorizations(base.clock, audit, accounts, base.config);
  const clearing = new Clearing(base.clock, ledger, audit, accounts, authorizations);
  return { ...base, ledger, audit, accounts, deposits, authorizations, clearing };
}
