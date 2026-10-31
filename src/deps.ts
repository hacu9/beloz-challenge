import type pg from "pg";
import { FakeBankApi } from "./fakes/fake-bank.js";
import { Accounts } from "./modules/accounts/accounts.js";
import { AuditLog } from "./modules/audit/audit.js";
import { ChargeOffs } from "./modules/closure/charge-offs.js";
import { Closure } from "./modules/closure/closure.js";
import { Deposits } from "./modules/collateral/deposits.js";
import { Ledger } from "./modules/ledger/ledger.js";
import type { BankClient } from "./modules/payouts/bank-client.js";
import { Payouts } from "./modules/payouts/payouts.js";
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
  bank: BankClient;
  ledger: Ledger;
  audit: AuditLog;
  accounts: Accounts;
  deposits: Deposits;
  authorizations: Authorizations;
  payouts: Payouts;
  clearing: Clearing;
  closure: Closure;
}

export function buildDeps(
  base: Pick<Deps, "config" | "pool" | "clock" | "logger"> & { bank?: BankClient },
): Deps {
  // Q5: the bank is simulated. A real deployment injects an HTTP client here.
  const bank = base.bank ?? new FakeBankApi();
  const ledger = new Ledger(base.clock);
  const audit = new AuditLog(base.clock);
  const accounts = new Accounts(base.clock, ledger, audit);
  const chargeOffs = new ChargeOffs(base.clock);
  const deposits = new Deposits(
    base.clock,
    ledger,
    audit,
    accounts,
    base.config.minDepositCentavos,
    chargeOffs,
  );
  const authorizations = new Authorizations(base.clock, audit, accounts, base.config);
  const payouts = new Payouts(base.clock, ledger, audit, accounts, bank);
  const clearing = new Clearing(
    base.clock,
    ledger,
    audit,
    accounts,
    authorizations,
    payouts,
    chargeOffs,
  );
  const closure = new Closure(
    base.clock,
    ledger,
    audit,
    accounts,
    authorizations,
    payouts,
    chargeOffs,
    base.config,
  );
  return {
    ...base,
    bank,
    ledger,
    audit,
    accounts,
    deposits,
    authorizations,
    payouts,
    clearing,
    closure,
  };
}
