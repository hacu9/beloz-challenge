import { afterAll, describe, expect, it } from "vitest";
import { withTx } from "../../src/platform/db/tx.js";
import { transfer } from "../../src/modules/ledger/ledger.js";
import { createHarness } from "../support/harness.js";

const h = createHarness();
afterAll(() => h.close());

// Writes one journal entry and one audit row. A row trigger fires only on an
// existing row, so each guard test seeds its own rows instead of relying on
// other test files to have written some first.
async function postSample(): Promise<string> {
  const { ledger, audit } = h.deps;
  return withTx(h.pool, async (tx) => {
    await audit.write(tx, {
      actor: { type: "system" },
      action: "schema.sample",
      entityType: "sample",
      entityId: "sample",
      before: null,
      after: null,
    });
    const debit = await ledger.systemAccountId(tx, "cash_operating");
    const credit = await ledger.systemAccountId(tx, "unapplied_funds");
    const { journalId } = await ledger.post(tx, {
      kind: "correction",
      lines: transfer(debit, credit, 1_000),
    });
    return journalId;
  });
}

describe("database guards", () => {
  it("MONEY-04: the pool returns bigint values as exact numbers and refuses unsafe ones", async () => {
    const ok = await h.pool.query<{ v: number }>("SELECT 9007199254740991::bigint AS v");
    expect(ok.rows[0]!.v).toBe(Number.MAX_SAFE_INTEGER);
    await expect(h.pool.query("SELECT 9007199254740992::bigint AS v")).rejects.toThrow(RangeError);
  });

  it("LEDGER-02: the DB rejects an unbalanced journal at commit, even when the app check is skipped", async () => {
    await expect(
      withTx(h.ownerPool, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO journal_entries (kind, created_at) VALUES ('correction', now()) RETURNING id",
        );
        const accounts = await tx.query<{ id: string }>(
          "SELECT id FROM ledger_accounts WHERE account_id IS NULL ORDER BY code LIMIT 2",
        );
        await tx.query(
          "INSERT INTO journal_lines (journal_id, ledger_account_id, amount) VALUES ($1, $2, 500), ($1, $3, -400)",
          [rows[0]!.id, accounts.rows[0]!.id, accounts.rows[1]!.id],
        );
      }),
    ).rejects.toThrow(/not balanced/);
  });

  it("LEDGER-02: the DB rejects a journal entry without lines", async () => {
    await expect(
      withTx(h.ownerPool, (tx) =>
        tx.query("INSERT INTO journal_entries (kind, created_at) VALUES ('correction', now())"),
      ),
    ).rejects.toThrow(/not balanced/);
  });

  it("LEDGER-03: a line cannot join an entry committed in an earlier transaction", async () => {
    const journalId = await postSample();
    const accounts = await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE account_id IS NULL ORDER BY code LIMIT 2",
    );
    await expect(
      withTx(h.ownerPool, (tx) =>
        tx.query(
          "INSERT INTO journal_lines (journal_id, ledger_account_id, amount) VALUES ($1, $2, 1), ($1, $3, -1)",
          [journalId, accounts.rows[0]!.id, accounts.rows[1]!.id],
        ),
      ),
    ).rejects.toThrow(/only be added in the transaction that created it/);
  });

  describe.each(["journal_entries", "journal_lines", "audit_log"])("%s", (table) => {
    it("LEDGER-04 / AUDIT-03: the trigger blocks UPDATE, DELETE and TRUNCATE for the owner", async () => {
      await postSample();
      const column = table === "journal_lines" ? "amount = amount" : "id = id";
      for (const sql of [
        `UPDATE ${table} SET ${column}`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table} CASCADE`,
      ]) {
        await expect(h.ownerPool.query(sql), sql).rejects.toThrow(/append-only table/);
      }
    });

    it("LEDGER-04 / AUDIT-03: the app role has no UPDATE, DELETE or TRUNCATE grant", async () => {
      for (const sql of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        await expect(h.pool.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });

  it("the account status CHECK includes frozen (OQ-11) and rejects unknown states", async () => {
    const insert = (status: string) =>
      h.ownerPool.query(
        `INSERT INTO accounts (customer_id, status, collateral_reference, repayment_reference, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, gen_random_uuid()::text, gen_random_uuid()::text, now(), now())`,
        [status],
      );
    await expect(insert("frozen")).resolves.toBeDefined();
    await expect(insert("suspended")).rejects.toThrow(/check constraint/);
  });
});
