import type { Deps } from "../deps.js";
import { withTx } from "../platform/db/tx.js";
import { withJobContext } from "./context.js";

// SPEND-09 sweep. Correctness does not depend on it (authorize and capture
// expire holds lazily under the account lock); it keeps the cached held_total
// and the account view fresh for accounts with no new activity.
export function expireDueHolds(deps: Deps): Promise<{ accounts: number }> {
  return withJobContext("expire-holds", () => expireDueHoldsRun(deps));
}

async function expireDueHoldsRun(deps: Deps): Promise<{ accounts: number }> {
  const { rows } = await deps.pool.query<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM holds WHERE status = 'open' AND expires_at <= $1",
    [deps.clock.now()],
  );
  for (const { account_id } of rows) {
    // One short transaction per account, with the same lock as any writer.
    await withTx(deps.pool, async (tx) => {
      const account = await deps.accounts.lock(tx, account_id);
      if (account) await deps.authorizations.expireHolds(tx, account);
    });
  }
  return { accounts: rows.length };
}
