import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { reconcile } from "../../src/jobs/reconcile.js";
import { seed, SEED_CUSTOMER_ID } from "../../src/jobs/seed.js";
import { createHarness, testConfig } from "../support/harness.js";
import { activeAccount, authorization, authorize, bankTransfer } from "../support/actors.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();

/** An account with collateral, a hold, debt and credit: every counter non-zero. */
async function busyAccount() {
  const a = await activeAccount(app, h, 100_000);
  const auth = authorization({ cardToken: a.cardToken, amount: 20_000 });
  await authorize(app, auth);
  await authorize(app, authorization({ cardToken: a.cardToken, amount: 5_000 }));
  await request(app)
    .post("/v1/network/captures")
    .set("X-Network-Key", testConfig.networkApiKey)
    .send({
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId: auth.networkAuthId,
      cardToken: a.cardToken,
      amount: 20_000,
      currency: "MXN",
    });
  await bankTransfer(app, h.clock, { reference: a.view.collateralReference, amount: 3_000 });
  return a.view.id;
}

describe("OPS-03: reconciliation", () => {
  it("reports no mismatch for accounts built through the service", async () => {
    const id = await busyAccount();
    const result = await reconcile(h.deps, { accountIds: [id] });
    expect(result).toEqual({ ok: true, accountsChecked: 1, ledgerTotal: 0, mismatches: [] });
  });

  // The account table is not append-only, so the owner can corrupt a cached
  // counter directly. Each check must notice its own kind of drift.
  it.each([
    ["credit_limit", "credit_limit_vs_ledger"],
    ["posted_debt", "posted_debt_vs_ledger"],
    ["credit_balance", "credit_balance_vs_ledger"],
    ["held_total", "held_total_vs_open_holds"],
    ["charged_off_outstanding", "charged_off_vs_log"],
  ])("detects a drifted %s", async (column, check) => {
    const id = await busyAccount();
    await h.ownerPool.query(`UPDATE accounts SET ${column} = ${column} + 1 WHERE id = $1`, [id]);
    const result = await reconcile(h.deps, { accountIds: [id] });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([expect.objectContaining({ check, accountId: id })]);
    // Put it back, so the shared database stays consistent for other tests.
    await h.ownerPool.query(`UPDATE accounts SET ${column} = ${column} - 1 WHERE id = $1`, [id]);
    expect((await reconcile(h.deps, { accountIds: [id] })).ok).toBe(true);
  });
});

describe("OPS-04: seed", () => {
  it("creates one active demo account once, and it reconciles", async () => {
    const first = await seed(h.deps);
    const second = await seed(h.deps);
    expect(second).toEqual({ created: false, accountId: first.accountId });
    const accounts = await h.deps.accounts.listForCustomer(h.pool, SEED_CUSTOMER_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.account).toMatchObject({ status: "active", credit_limit: 1_000_000 });
    expect((await reconcile(h.deps, { accountIds: [first.accountId] })).ok).toBe(true);
  });
});
