import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { transferReceived } from "../../src/fakes/fake-bank.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import { signWebhook } from "../../src/fakes/fake-bank.js";
import { bankTransfer, bearer, getAccount, openAccount } from "../support/actors.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();
const { ledger } = h.deps;
const MIN = testConfig.minDepositCentavos;

async function freshAccount(): Promise<{ auth: string; view: AccountView }> {
  const auth = await bearer("customer", h.clock);
  return { auth, view: await openAccount(app, auth) };
}

async function journalsFor(bankTxnId: string): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries je
     JOIN bank_transactions bt ON bt.journal_id = je.id WHERE bt.bank_txn_id = $1`,
    [bankTxnId],
  );
  return rows[0]!.n;
}

/** LEDGER-06: the cached counters equal the ledger balances of the account. */
async function expectCacheMatchesLedger(accountId: string) {
  const own = await ledger.customerAccounts(h.pool, accountId);
  const { rows } = await h.pool.query<{
    credit_limit: number;
    posted_debt: number;
    credit_balance: number;
  }>("SELECT credit_limit, posted_debt, credit_balance FROM accounts WHERE id = $1", [accountId]);
  const cached = rows[0]!;
  // Liabilities carry negative (credit) balances; the asset carries a positive one.
  // `0 - x`, not `-x`: -(0) is -0, which toBe (Object.is) treats as different from 0.
  expect(cached.credit_limit).toBe(0 - (await ledger.balance(h.pool, own.customer_collateral)));
  expect(cached.credit_balance).toBe(0 - (await ledger.balance(h.pool, own.customer_credit)));
  expect(cached.posted_debt).toBe(await ledger.balance(h.pool, own.customer_receivable));
}

describe("collateral deposit", () => {
  it("COL-04: a confirmed deposit at or above the minimum activates the account and card 1:1", async () => {
    const { auth, view } = await freshAccount();
    const bankTxnId = `spei_${randomUUID()}`;
    const res = await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: 125_000,
      bankTxnId,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bankTxnId,
      outcome: "collateral_confirmed",
      accountId: view.id,
      duplicate: false,
    });

    const after = (await getAccount(app, auth, view.id)).body as AccountView;
    expect(after).toMatchObject({
      status: "active",
      creditLimit: 125_000,
      availableCredit: 125_000,
      card: { status: "active" },
    });
    await expectCacheMatchesLedger(view.id);

    const actions = await h.pool.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id IN ($1, $2) ORDER BY id",
      [view.id, bankTxnId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      "account.opened",
      "account.activated",
      "deposit.collateral_confirmed",
    ]);
  });

  it("COL-02: an unsigned deposit is rejected and records nothing", async () => {
    const { auth, view } = await freshAccount();
    const res = await request(app)
      .post("/v1/bank/webhooks")
      .set("content-type", "application/json")
      .send(transferReceived({ reference: view.collateralReference, amount: 500_000 }));
    expect(res.status).toBe(401);
    expect((await getAccount(app, auth, view.id)).body.status).toBe("pending_collateral");
  });

  it("COL-03: a duplicate returns the first result and posts nothing new", async () => {
    const { view } = await freshAccount();
    const args = {
      reference: view.collateralReference,
      amount: 80_000,
      bankTxnId: `spei_${randomUUID()}`,
    };
    await bankTransfer(app, h.clock, args);
    const dup = await bankTransfer(app, h.clock, args);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ outcome: "collateral_confirmed", duplicate: true });
    expect(await journalsFor(args.bankTxnId)).toBe(1);
    await expectCacheMatchesLedger(view.id);
  });

  it("COL-03: the same bank ID with a different amount is a 409 conflict", async () => {
    const { view } = await freshAccount();
    const bankTxnId = `spei_${randomUUID()}`;
    await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: 80_000,
      bankTxnId,
    });
    const res = await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: 90_000,
      bankTxnId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("bank_txn_conflict");
  });

  it("COL-03: 10 overlapping deliveries of one transfer post one journal", async () => {
    const { auth, view } = await freshAccount();
    const server = await listen(app);
    try {
      const { payload, headers } = signWebhook(
        transferReceived({
          reference: view.collateralReference,
          amount: 60_000,
          bankTxnId: `spei_${randomUUID()}`,
        }),
        testConfig.bankWebhookSecret,
        h.clock,
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${server.url}/v1/bank/webhooks`, { method: "POST", headers, body: payload }).then(
            async (r) => ({ status: r.status, body: (await r.json()) as { duplicate: boolean } }),
          ),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(results.filter((r) => !r.body.duplicate)).toHaveLength(1);
      expect((await getAccount(app, auth, view.id)).body.creditLimit).toBe(60_000);
      await expectCacheMatchesLedger(view.id);
    } finally {
      await server.close();
    }
  });

  it("COL-06: two different transfers racing on a pending account activate it once", async () => {
    const { auth, view } = await freshAccount();
    const server = await listen(app);
    try {
      const send = (amount: number) => {
        const { payload, headers } = signWebhook(
          transferReceived({ reference: view.collateralReference, amount }),
          testConfig.bankWebhookSecret,
          h.clock,
        );
        return fetch(`${server.url}/v1/bank/webhooks`, {
          method: "POST",
          headers,
          body: payload,
        }).then((r) => r.json() as Promise<{ outcome: string }>);
      };
      const outcomes = (await Promise.all([send(70_000), send(90_000)]))
        .map((b) => b.outcome)
        .sort();
      expect(outcomes).toEqual(["collateral_confirmed", "credited_for_payback"]);

      const after = (await getAccount(app, auth, view.id)).body as AccountView;
      expect(after.status).toBe("active");
      expect(after.creditLimit + after.creditBalance).toBe(160_000);
      expect([70_000, 90_000]).toContain(after.creditLimit);
      await expectCacheMatchesLedger(view.id);
    } finally {
      await server.close();
    }
  });

  it("COL-09: a deposit below the minimum is credited for payback and the account stays pending", async () => {
    const { auth, view } = await freshAccount();
    const res = await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: MIN - 1,
    });
    expect(res.body.outcome).toBe("credited_below_minimum");
    const after = (await getAccount(app, auth, view.id)).body as AccountView;
    expect(after).toMatchObject({
      status: "pending_collateral",
      creditLimit: 0,
      creditBalance: MIN - 1,
      card: { status: "inactive" },
    });
    await expectCacheMatchesLedger(view.id);

    // Exactly the minimum activates.
    const ok = await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: MIN,
    });
    expect(ok.body.outcome).toBe("collateral_confirmed");
  });

  it("COL-07: a second collateral transfer to an active account is credited, not added to the limit", async () => {
    const { auth, view } = await freshAccount();
    await bankTransfer(app, h.clock, { reference: view.collateralReference, amount: 100_000 });
    const res = await bankTransfer(app, h.clock, {
      reference: view.collateralReference,
      amount: 30_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("credited_for_payback");
    const after = (await getAccount(app, auth, view.id)).body as AccountView;
    expect(after).toMatchObject({ creditLimit: 100_000, creditBalance: 30_000 });
    await expectCacheMatchesLedger(view.id);

    // The cash landed in the segregated collateral bank account.
    const cashCollateral = await ledger.systemAccountId(h.pool, "cash_collateral");
    const { rows } = await h.pool.query(
      `SELECT jl.amount FROM bank_transactions bt
       JOIN journal_lines jl ON jl.journal_id = bt.journal_id
       WHERE bt.bank_txn_id = $1 AND jl.ledger_account_id = $2`,
      [res.body.bankTxnId, cashCollateral],
    );
    expect(rows).toEqual([{ amount: 30_000 }]);
  });

  it("COL-08: an unknown reference goes to unapplied_funds and is flagged", async () => {
    const unapplied = await ledger.systemAccountId(h.pool, "unapplied_funds");
    const bankTxnId = `spei_${randomUUID()}`;
    const res = await bankTransfer(app, h.clock, {
      reference: "000000000000000000",
      amount: 42_000,
      bankTxnId,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "unapplied", accountId: null });
    const { rows } = await h.pool.query(
      `SELECT bt.outcome, jl.amount FROM bank_transactions bt
       JOIN journal_lines jl ON jl.journal_id = bt.journal_id
       WHERE bt.bank_txn_id = $1 AND jl.ledger_account_id = $2`,
      [bankTxnId, unapplied],
    );
    expect(rows).toEqual([{ outcome: "unapplied", amount: -42_000 }]);
  });

  it("a transfer to the repayment reference returns 501 until M6 and records nothing", async () => {
    const { view } = await freshAccount();
    const bankTxnId = `spei_${randomUUID()}`;
    const res = await bankTransfer(app, h.clock, {
      reference: view.repaymentReference,
      amount: 10_000,
      bankTxnId,
    });
    expect(res.status).toBe(501);
    const { rowCount } = await h.pool.query(
      "SELECT 1 FROM bank_transactions WHERE bank_txn_id = $1",
      [bankTxnId],
    );
    expect(rowCount).toBe(0);
  });

  it("rejects a non-MXN or fractional transfer as malformed (422)", async () => {
    const { view } = await freshAccount();
    for (const body of [
      {
        ...transferReceived({ reference: view.collateralReference, amount: 100_000 }),
        currency: "USD",
      },
      {
        ...transferReceived({ reference: view.collateralReference, amount: 100_000 }),
        amount: 1000.5,
      },
    ]) {
      const { payload, headers } = signWebhook(body, testConfig.bankWebhookSecret, h.clock);
      const res = await request(app).post("/v1/bank/webhooks").set(headers).send(payload);
      expect(res.status).toBe(422);
    }
  });

  it("Q24: the whole ledger still sums to zero", async () => {
    expect(await ledger.trialBalance(h.pool)).toBe(0);
  });
});
