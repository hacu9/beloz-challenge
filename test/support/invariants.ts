import { expect } from "vitest";
import type { Harness } from "./harness.js";

// LEDGER-06 / Q25: the cached counters on an account equal what the ledger
// and the holds table say. `0 - x`, not `-x`: -(0) is -0, which toBe
// (Object.is) treats as different from 0.
export async function expectAccountConsistent(h: Harness, accountId: string): Promise<void> {
  const { ledger } = h.deps;
  const own = await ledger.customerAccounts(h.pool, accountId);
  const { rows } = await h.pool.query<{
    credit_limit: number;
    posted_debt: number;
    held_total: number;
    credit_balance: number;
    open_holds: number;
  }>(
    `SELECT a.credit_limit, a.posted_debt, a.held_total, a.credit_balance,
            (SELECT coalesce(sum(amount), 0) FROM holds WHERE account_id = a.id AND status = 'open') AS open_holds
     FROM accounts a WHERE a.id = $1`,
    [accountId],
  );
  const a = rows[0]!;
  expect(a.credit_limit, "credit_limit vs ledger").toBe(
    0 - (await ledger.balance(h.pool, own.customer_collateral)),
  );
  expect(a.posted_debt, "posted_debt vs ledger").toBe(
    await ledger.balance(h.pool, own.customer_receivable),
  );
  expect(a.credit_balance, "credit_balance vs ledger").toBe(
    0 - (await ledger.balance(h.pool, own.customer_credit)),
  );
  expect(a.held_total, "held_total vs open holds").toBe(a.open_holds);
}
