import { afterAll, describe, expect, it } from "vitest";
import { transfer, UnbalancedJournalError } from "../../src/modules/ledger/ledger.js";
import { withTx } from "../../src/platform/db/tx.js";
import { createHarness } from "../support/harness.js";

const h = createHarness();
afterAll(() => h.close());
const { ledger } = h.deps;

async function newCustomerAccount(): Promise<string> {
  const { rows } = await h.pool.query<{ id: string }>(
    `INSERT INTO accounts (customer_id, status, collateral_reference, repayment_reference, created_at, updated_at)
     VALUES (gen_random_uuid(), 'pending_collateral', gen_random_uuid()::text, gen_random_uuid()::text, $1, $1)
     RETURNING id`,
    [h.clock.now()],
  );
  return rows[0]!.id;
}

describe("ledger", () => {
  it("LEDGER-01: posts one entry with its lines, and balances follow", async () => {
    const accountId = await newCustomerAccount();
    const { journalId, accounts } = await withTx(h.pool, async (tx) => {
      const accounts = await ledger.openCustomerAccounts(tx, accountId);
      const cash = await ledger.systemAccountId(tx, "cash_collateral");
      const posted = await ledger.post(tx, {
        kind: "deposit",
        accountId,
        lines: transfer(cash, accounts.customer_collateral, 75_000),
      });
      return { ...posted, accounts };
    });

    const lines = await h.pool.query("SELECT amount FROM journal_lines WHERE journal_id = $1", [
      journalId,
    ]);
    expect(lines.rows.map((r: { amount: number }) => r.amount).sort((a, b) => a - b)).toEqual([
      -75_000, 75_000,
    ]);
    // A liability carries a credit (negative) balance.
    expect(await ledger.balance(h.pool, accounts.customer_collateral)).toBe(-75_000);
    expect(await ledger.customerAccounts(h.pool, accountId)).toEqual(accounts);
  });

  it("LEDGER-01: a multi-line entry (collateral application) balances across four lines", async () => {
    const accountId = await newCustomerAccount();
    await withTx(h.pool, async (tx) => {
      const acc = await ledger.openCustomerAccounts(tx, accountId);
      const cashCollateral = await ledger.systemAccountId(tx, "cash_collateral");
      const cashOperating = await ledger.systemAccountId(tx, "cash_operating");
      await ledger.post(tx, {
        kind: "collateral_application",
        accountId,
        lines: [
          { ledgerAccountId: acc.customer_collateral, amount: 300 },
          { ledgerAccountId: cashOperating, amount: 300 },
          { ledgerAccountId: acc.customer_receivable, amount: -300 },
          { ledgerAccountId: cashCollateral, amount: -300 },
        ],
      });
    });
  });

  it("LEDGER-02: the app rejects unbalanced, single-line, zero and fractional lines before the DB", async () => {
    await withTx(h.pool, async (tx) => {
      const a = await ledger.systemAccountId(tx, "cash_operating");
      const b = await ledger.systemAccountId(tx, "unapplied_funds");
      const cases = [
        [{ ledgerAccountId: a, amount: 100 }, { ledgerAccountId: b, amount: -99 }],
        [{ ledgerAccountId: a, amount: 100 }],
        [{ ledgerAccountId: a, amount: 0 }, { ledgerAccountId: b, amount: 0 }],
      ];
      for (const lines of cases) {
        await expect(ledger.post(tx, { kind: "correction", lines })).rejects.toThrow(
          UnbalancedJournalError,
        );
      }
      await expect(
        ledger.post(tx, {
          kind: "correction",
          lines: [
            { ledgerAccountId: a, amount: 0.5 },
            { ledgerAccountId: b, amount: -0.5 },
          ],
        }),
      ).rejects.toThrow(RangeError);
    });
  });

  it("LEDGER-03: a correction is a new entry that references the original", async () => {
    const { original, correction } = await withTx(h.pool, async (tx) => {
      const a = await ledger.systemAccountId(tx, "cash_operating");
      const b = await ledger.systemAccountId(tx, "unapplied_funds");
      const original = await ledger.post(tx, { kind: "correction", lines: transfer(a, b, 10) });
      const correction = await ledger.post(tx, {
        kind: "correction",
        reversesId: original.journalId,
        lines: transfer(b, a, 10),
      });
      return { original, correction };
    });
    const { rows } = await h.pool.query<{ reverses_id: string }>(
      "SELECT reverses_id FROM journal_entries WHERE id = $1",
      [correction.journalId],
    );
    expect(rows[0]!.reverses_id).toBe(original.journalId);
  });

  it("LEDGER-06: the entry rolls back with the transaction that posted it", async () => {
    let journalId = "";
    await expect(
      withTx(h.pool, async (tx) => {
        const a = await ledger.systemAccountId(tx, "cash_operating");
        const b = await ledger.systemAccountId(tx, "unapplied_funds");
        ({ journalId } = await ledger.post(tx, { kind: "correction", lines: transfer(a, b, 10) }));
        throw new Error("business rule failed after the post");
      }),
    ).rejects.toThrow("business rule failed");
    const { rowCount } = await h.pool.query("SELECT 1 FROM journal_entries WHERE id = $1", [
      journalId,
    ]);
    expect(rowCount).toBe(0);
  });

  it("Q24: the whole ledger sums to zero", async () => {
    expect(await ledger.trialBalance(h.pool)).toBe(0);
  });
});
