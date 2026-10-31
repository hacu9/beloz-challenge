import type { Deps } from "../deps.js";

export interface Mismatch {
  check: string;
  accountId: string | null;
  expected: number;
  actual: number;
}

// OPS-03, Q25: recomputes every cached number from its source of truth.
// Read-only. A non-empty `mismatches` means the books and the cache disagree;
// the CLI exits non-zero so a scheduler or CI step fails loudly.
export async function reconcile(
  deps: Deps,
  opts: { accountIds?: string[] } = {},
): Promise<{ ok: boolean; accountsChecked: number; ledgerTotal: number; mismatches: Mismatch[] }> {
  const mismatches: Mismatch[] = [];

  // (a) The whole ledger sums to zero.
  const ledgerTotal = await deps.ledger.trialBalance(deps.pool);
  if (ledgerTotal !== 0) {
    mismatches.push({
      check: "ledger_sums_to_zero",
      accountId: null,
      expected: 0,
      actual: ledgerTotal,
    });
  }

  // (b) and (c), per account, in one statement. Liabilities carry negative
  // ledger balances, so they are negated to compare with the cache.
  const { rows } = await deps.pool.query<{
    id: string;
    credit_limit: number;
    collateral_ledger: number;
    posted_debt: number;
    receivable_ledger: number;
    credit_balance: number;
    credit_ledger: number;
    held_total: number;
    open_holds: number;
    charged_off_outstanding: number;
    charge_off_net: number;
    credit_returnable: number;
  }>(
    `SELECT a.id, a.credit_limit, a.posted_debt, a.credit_balance, a.held_total,
            a.charged_off_outstanding, a.credit_returnable,
            0 - coalesce((SELECT sum(jl.amount) FROM journal_lines jl
                          JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                          WHERE la.account_id = a.id AND la.code = 'customer_collateral'), 0) AS collateral_ledger,
            coalesce((SELECT sum(jl.amount) FROM journal_lines jl
                      JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                      WHERE la.account_id = a.id AND la.code = 'customer_receivable'), 0) AS receivable_ledger,
            0 - coalesce((SELECT sum(jl.amount) FROM journal_lines jl
                          JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                          WHERE la.account_id = a.id AND la.code = 'customer_credit'), 0) AS credit_ledger,
            coalesce((SELECT sum(amount) FROM holds h
                      WHERE h.account_id = a.id AND h.status = 'open'), 0) AS open_holds,
            coalesce((SELECT sum(CASE WHEN kind = 'charge_off' THEN amount ELSE -amount END)
                      FROM charge_offs c WHERE c.account_id = a.id), 0) AS charge_off_net
     FROM accounts a
     WHERE ($1::uuid[] IS NULL OR a.id = ANY($1))`,
    [opts.accountIds ?? null],
  );

  for (const r of rows) {
    const pairs: [string, number, number][] = [
      ["credit_limit_vs_ledger", r.collateral_ledger, r.credit_limit],
      ["posted_debt_vs_ledger", r.receivable_ledger, r.posted_debt],
      ["credit_balance_vs_ledger", r.credit_ledger, r.credit_balance],
      ["held_total_vs_open_holds", r.open_holds, r.held_total],
      ["charged_off_vs_log", r.charge_off_net, r.charged_off_outstanding],
    ];
    for (const [check, expected, actual] of pairs) {
      if (expected !== actual) mismatches.push({ check, accountId: r.id, expected, actual });
    }
    if (r.credit_returnable > r.credit_balance) {
      mismatches.push({
        check: "returnable_within_credit",
        accountId: r.id,
        expected: r.credit_balance,
        actual: r.credit_returnable,
      });
    }
  }

  return { ok: mismatches.length === 0, accountsChecked: rows.length, ledgerTotal, mismatches };
}
