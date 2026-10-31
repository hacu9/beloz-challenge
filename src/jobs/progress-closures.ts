import type { Deps } from "../deps.js";
import { withTx } from "../platform/db/tx.js";
import { withJobContext } from "./context.js";

// CLOSE-03..08. Moves each closing/settling account one step, and settles
// late money on closed accounts (CLOSE-08). One short transaction per
// account; payouts are sent after the commit, with no lock held.
export function progressClosures(
  deps: Deps,
  opts: { accountIds?: string[] } = {},
): Promise<{ accounts: number; closed: number }> {
  return withJobContext("progress-closures", () => progressClosuresRun(deps, opts));
}

async function progressClosuresRun(
  deps: Deps,
  opts: { accountIds?: string[] } = {},
): Promise<{ accounts: number; closed: number }> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM accounts
     WHERE (status IN ('closing', 'settling')
            OR (status = 'closed' AND (posted_debt > 0 OR credit_balance > 0 OR credit_limit > 0)))
       AND ($1::uuid[] IS NULL OR id = ANY($1))`,
    [opts.accountIds ?? null],
  );
  let closed = 0;
  for (const { id } of rows) {
    const step = await withTx(deps.pool, (tx) => deps.closure.progress(tx, id));
    for (const p of step.payouts) await deps.payouts.submit(deps.pool, p.id);
    if (step.account.status === "closed") closed++;
  }
  return { accounts: rows.length, closed };
}
