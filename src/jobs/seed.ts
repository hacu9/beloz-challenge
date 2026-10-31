import type { Deps } from "../deps.js";
import { withTx } from "../platform/db/tx.js";
import { withJobContext } from "./context.js";

// OPS-04: one demo customer with an active account, so a fresh stack has
// something to look at. Idempotent: a second run finds the account and stops.
// It goes through the same module code as the API and the bank webhook, so
// the seed passes every invariant the reconciliation checks.
export const SEED_CUSTOMER_ID = "00000000-0000-4000-8000-000000000001";
const SEED_PAYOUT_CLABE = "012180001234567897";
const SEED_COLLATERAL = 1_000_000; // 10,000.00 MXN

export function seed(deps: Deps): Promise<{ created: boolean; accountId: string }> {
  return withJobContext("seed", () => seedRun(deps));
}

async function seedRun(deps: Deps): Promise<{ created: boolean; accountId: string }> {
  const existing = await deps.accounts.listForCustomer(deps.pool, SEED_CUSTOMER_ID);
  if (existing[0]) return { created: false, accountId: existing[0].account.id };

  const { account } = await withTx(deps.pool, (tx) =>
    deps.accounts.open(tx, SEED_CUSTOMER_ID, SEED_PAYOUT_CLABE, { type: "system" }),
  );
  await withTx(deps.pool, (tx) =>
    deps.deposits.receive(tx, {
      type: "transfer.received",
      bankTxnId: `seed_${account.id}`,
      reference: account.collateral_reference,
      amount: SEED_COLLATERAL,
      currency: "MXN",
    }),
  );
  return { created: true, accountId: account.id };
}
