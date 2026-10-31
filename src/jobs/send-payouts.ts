import type { Deps } from "../deps.js";
import { withTx } from "../platform/db/tx.js";
import type { PayoutStatus } from "../modules/payouts/payouts.js";

// REPAY-04, PAYOUT-11. Runs on a schedule. Until it runs, free credit can
// still net against new debt (PAYOUT-10); once it created a payout, that money
// is reserved. Each account gets its own short transaction; each payout is
// sent after its commit, with no lock held during the bank call.
export async function sendDuePayouts(
  deps: Deps,
  opts: { accountIds?: string[] } = {},
): Promise<{ created: number; statuses: PayoutStatus[] }> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM accounts
     WHERE credit_balance > 0 AND payout_clabe IS NOT NULL
       AND ($1::uuid[] IS NULL OR id = ANY($1))`,
    [opts.accountIds ?? null],
  );
  const statuses: PayoutStatus[] = [];
  let created = 0;
  for (const { id } of rows) {
    const payouts = await withTx(deps.pool, (tx) => deps.payouts.createDue(tx, id));
    created += payouts.length;
    for (const p of payouts) statuses.push(await deps.payouts.submit(deps.pool, p.id));
  }
  return { created, statuses };
}
