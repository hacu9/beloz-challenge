// Regression tests for the blind review of 2026-10-31 (findings A1, A2, B1,
// B2, B3) and the OQ-13 decision. Each test reproduces the finding's scenario.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payoutResult, signWebhook } from "../../src/fakes/fake-bank.js";
import { progressClosures } from "../../src/jobs/progress-closures.js";
import { sendDuePayouts } from "../../src/jobs/send-payouts.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { withTx } from "../../src/platform/db/tx.js";
import { createHarness, testConfig } from "../support/harness.js";
import { activeAccount, bankTransfer, bearer, getAccount, openAccount } from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => {
  h.bank.mode = "accept";
});
const app = h.app();
const WINDOW_MS = testConfig.closingCaptureWindowDays * 24 * 60 * 60 * 1000;
const NEW_CLABE = "002180009876543210";

interface PayoutView {
  id: string;
  kind: string;
  amount: number;
  status: string;
  parked: boolean;
}

const capture = (cardToken: string, amount: number) =>
  request(app)
    .post("/v1/network/captures")
    .set("X-Network-Key", testConfig.networkApiKey)
    .send({ networkCaptureId: `cap_${randomUUID()}`, cardToken, amount, currency: "MXN" });

const refund = (cardToken: string, amount: number) =>
  request(app)
    .post("/v1/network/refunds")
    .set("X-Network-Key", testConfig.networkApiKey)
    .send({ networkRefundId: `ref_${randomUUID()}`, cardToken, amount, currency: "MXN" });

const view = async (id: string) =>
  (await getAccount(app, await bearer("ops", h.clock), id)).body as AccountView;

async function payoutsOf(accountId: string): Promise<PayoutView[]> {
  const res = await request(app)
    .get(`/v1/ops/payouts?accountId=${accountId}`)
    .set("Authorization", await bearer("ops", h.clock));
  return (res.body as { payouts: PayoutView[] }).payouts;
}

async function opsAction(payoutId: string, path: "resolve" | "release", body: object) {
  return request(app)
    .post(`/v1/ops/payouts/${payoutId}/${path}`)
    .set("Authorization", await bearer("ops", h.clock))
    .set("Idempotency-Key", randomUUID())
    .send({ note: "review fix test", ...body });
}

async function bankSays(payoutId: string, result: "completed" | "failed") {
  const { payload, headers } = signWebhook(
    payoutResult({ payoutId, result }),
    testConfig.bankWebhookSecret,
    h.clock,
  );
  return request(app).post("/v1/bank/webhooks").set(headers).send(payload);
}

async function closeAndWait(accountId: string, auth: string) {
  await request(app)
    .post(`/v1/accounts/${accountId}/close`)
    .set("Authorization", auth)
    .set("Idempotency-Key", randomUUID())
    .send({});
  h.clock.advanceMs(WINDOW_MS);
}

const progress = (id: string) => progressClosures(h.deps, { accountIds: [id] });

describe("A2: released credit pays debt before it is paid out", () => {
  it("credit freed after debt appeared nets first; only the rest goes out", async () => {
    const a = await activeAccount(app, h, 100_000);
    await capture(a.cardToken, 20_000);
    await bankTransfer(app, h.clock, { reference: a.view.repaymentReference, amount: 30_000 });
    h.bank.mode = "reject";
    await sendDuePayouts(h.deps, { accountIds: [a.view.id] }); // 10,000 held, failed
    h.bank.mode = "accept";
    await capture(a.cardToken, 6_000); // held credit does not net
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 6_000, creditBalance: 10_000 });

    const [failed] = await payoutsOf(a.view.id);
    await opsAction(failed!.id, "resolve", { action: "cancel" });
    await opsAction(failed!.id, "release", {});
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 0, creditBalance: 4_000 });

    await sendDuePayouts(h.deps, { accountIds: [a.view.id] });
    const live = (await payoutsOf(a.view.id)).filter((p) => p.status !== "cancelled");
    expect(live.map((p) => p.amount)).toEqual([4_000]);
    await expectAccountConsistent(h, a.view.id);
  });
});

describe("B2: a refund after a charge-off recovers the loss first", () => {
  it("CLOSE-09: the refund reduces charged-off debt, not becomes credit", async () => {
    const a = await activeAccount(app, h, 100_000);
    await capture(a.cardToken, 125_000);
    await closeAndWait(a.view.id, a.auth);
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({
      status: "closed",
      chargedOffOutstanding: 25_000,
    });

    const res = await refund(a.cardToken, 2_000);
    expect(res.body).toMatchObject({ debtReduced: 0, credited: 0 });
    expect(await view(a.view.id)).toMatchObject({
      chargedOffOutstanding: 23_000,
      creditBalance: 0,
    });

    // A refund larger than what is owed: the rest is credit.
    await refund(a.cardToken, 30_000);
    expect(await view(a.view.id)).toMatchObject({ chargedOffOutstanding: 0, creditBalance: 7_000 });
    await expectAccountConsistent(h, a.view.id);
  });
});

describe("PAYOUT-17 / B1: one payout is sent to the bank once", () => {
  it("two concurrent submits of the same payout make one bank call", async () => {
    const a = await activeAccount(app, h, 100_000);
    await bankTransfer(app, h.clock, { reference: a.view.repaymentReference, amount: 5_000 });
    const [payout] = await withTx(h.pool, (tx) => h.deps.payouts.createDue(tx, a.view.id));
    const before = h.bank.requests.filter((r) => r.payoutId === payout!.id).length;
    await Promise.all([
      h.deps.payouts.submit(h.pool, payout!.id),
      h.deps.payouts.submit(h.pool, payout!.id),
      h.deps.payouts.submit(h.pool, payout!.id),
    ]);
    expect(h.bank.requests.filter((r) => r.payoutId === payout!.id).length - before).toBe(1);
  });
});

describe("PAYOUT-16 / A1: collateral of a failed payout covers debt", () => {
  it("a failed collateral payout is taken back when a late capture creates debt", async () => {
    const a = await activeAccount(app, h, 100_000);
    await closeAndWait(a.view.id, a.auth);
    h.bank.mode = "reject";
    await progress(a.view.id);
    expect((await payoutsOf(a.view.id))[0]).toMatchObject({ kind: "collateral", status: "failed" });

    h.bank.mode = "accept";
    await capture(a.cardToken, 4_000);
    await progress(a.view.id);
    const payouts = await payoutsOf(a.view.id);
    expect(payouts.map((p) => [p.status, p.amount, p.parked]).sort()).toEqual([
      ["cancelled", 100_000, false],
      ["requested", 96_000, false],
    ]);
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 0, chargedOffOutstanding: 0 });
    await expectAccountConsistent(h, a.view.id);
  });

  it("an unknown collateral payout keeps the charge-off; when it turns failed, collateral recovers it", async () => {
    const a = await activeAccount(app, h, 100_000);
    await closeAndWait(a.view.id, a.auth);
    h.bank.mode = "timeout";
    await progress(a.view.id);
    const [unknown] = await payoutsOf(a.view.id);
    expect(unknown).toMatchObject({ status: "unknown", amount: 100_000 });

    h.bank.mode = "accept";
    await capture(a.cardToken, 4_000);
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 0, chargedOffOutstanding: 4_000 });

    await bankSays(unknown!.id, "failed");
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({
      chargedOffOutstanding: 0,
      creditLimit: 96_000,
    });
    const live = (await payoutsOf(a.view.id)).filter((p) => p.status === "requested");
    expect(live.map((p) => p.amount)).toEqual([96_000]);
    await expectAccountConsistent(h, a.view.id);

    for (const p of live) await bankSays(p.id, "completed");
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closed");
    expect(await h.deps.ledger.trialBalance(h.pool)).toBe(0);
  });
});

describe("B3: a collateral-reference deposit recovers charged-off debt first", () => {
  it("recovers the charge-off and returns only the rest", async () => {
    const a = await activeAccount(app, h, 100_000);
    await capture(a.cardToken, 125_000);
    await closeAndWait(a.view.id, a.auth);
    await progress(a.view.id);
    expect((await view(a.view.id)).chargedOffOutstanding).toBe(25_000);

    await bankTransfer(app, h.clock, { reference: a.view.collateralReference, amount: 30_000 });
    expect(await view(a.view.id)).toMatchObject({ chargedOffOutstanding: 0, creditBalance: 5_000 });
    await progress(a.view.id);
    expect(await payoutsOf(a.view.id)).toEqual([
      expect.objectContaining({ kind: "return", amount: 5_000 }),
    ]);
    await expectAccountConsistent(h, a.view.id);
  });

  it("D-M6-1 still holds for open debt: the deposit is returned in full", async () => {
    const a = await activeAccount(app, h, 100_000);
    await capture(a.cardToken, 10_000);
    await bankTransfer(app, h.clock, { reference: a.view.collateralReference, amount: 30_000 });
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 10_000, creditBalance: 30_000 });
    await sendDuePayouts(h.deps, { accountIds: [a.view.id] });
    expect(await payoutsOf(a.view.id)).toEqual([
      expect.objectContaining({ kind: "return", amount: 30_000 }),
    ]);
  });
});

describe("PAYOUT-15 / OQ-13: cancel parks; release lets the account finish", () => {
  it("a parked collateral payout is not re-created until release", async () => {
    const a = await activeAccount(app, h, 100_000);
    await closeAndWait(a.view.id, a.auth);
    h.bank.mode = "reject";
    await progress(a.view.id);
    const [failed] = await payoutsOf(a.view.id);
    expect(failed).toMatchObject({ kind: "collateral", status: "failed" });

    h.bank.mode = "accept";
    await opsAction(failed!.id, "resolve", { action: "cancel" });
    await progress(a.view.id);
    expect(await payoutsOf(a.view.id)).toHaveLength(1); // parked: no second payout
    expect((await view(a.view.id)).status).toBe("settling");

    await opsAction(failed!.id, "release", { payoutClabe: NEW_CLABE });
    await progress(a.view.id);
    const fresh = (await payoutsOf(a.view.id)).find((p) => p.status === "requested");
    expect(fresh).toMatchObject({ kind: "collateral", amount: 100_000 });
    await bankSays(fresh!.id, "completed");
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closed");
    await expectAccountConsistent(h, a.view.id);
  });

  it("a parked return blocks closure until ops releases it with a new CLABE", async () => {
    const auth = await bearer("customer", h.clock);
    const v = await openAccount(app, auth);
    await bankTransfer(app, h.clock, {
      reference: v.collateralReference,
      amount: testConfig.minDepositCentavos - 1,
    });
    await closeAndWait(v.id, auth);
    h.bank.mode = "reject";
    await progress(v.id);
    const [ret] = await payoutsOf(v.id);
    expect(ret).toMatchObject({ kind: "return", status: "failed" });

    h.bank.mode = "accept";
    await opsAction(ret!.id, "resolve", { action: "cancel" });
    await progress(v.id);
    await sendDuePayouts(h.deps, { accountIds: [v.id] });
    expect((await view(v.id)).status).toBe("settling"); // parked money keeps it open
    expect(await payoutsOf(v.id)).toHaveLength(1); // nothing re-created

    expect((await opsAction(ret!.id, "release", { payoutClabe: NEW_CLABE })).status).toBe(200);
    expect((await opsAction(ret!.id, "release", {})).status).toBe(409); // only once
    await progress(v.id);
    const fresh = (await payoutsOf(v.id)).find((p) => p.status === "requested");
    expect(fresh).toMatchObject({ kind: "return", amount: testConfig.minDepositCentavos - 1 });
    expect(h.bank.requests.at(-1)).toMatchObject({
      payoutId: fresh!.id,
      destinationClabe: NEW_CLABE,
    });

    await bankSays(fresh!.id, "completed");
    await progress(v.id);
    expect((await view(v.id)).status).toBe("closed");
    await expectAccountConsistent(h, v.id);
  });
});
