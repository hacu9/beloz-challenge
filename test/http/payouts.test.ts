import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payoutResult, signWebhook } from "../../src/fakes/fake-bank.js";
import { sendDuePayouts } from "../../src/jobs/send-payouts.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import {
  activeAccount,
  authorization,
  authorize,
  bankTransfer,
  bearer,
  getAccount,
  PAYOUT_CLABE,
} from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => {
  h.bank.mode = "accept";
});
const app = h.app();

interface PayoutView {
  id: string;
  kind: string;
  amount: number;
  status: string;
  sourceCash: string;
  mismatch: boolean;
  resolvedBy: string | null;
}

const network = (path: string, body: object) =>
  request(app).post(`/v1/network${path}`).set("X-Network-Key", testConfig.networkApiKey).send(body);

async function view(accountId: string): Promise<AccountView> {
  return (await getAccount(app, await bearer("ops", h.clock), accountId)).body as AccountView;
}

async function payoutsOf(accountId: string): Promise<PayoutView[]> {
  const res = await request(app)
    .get(`/v1/ops/payouts?accountId=${accountId}`)
    .set("Authorization", await bearer("ops", h.clock));
  return (res.body as { payouts: PayoutView[] }).payouts;
}

function bankResult(payoutId: string, result: "completed" | "failed", bankTxnId?: string) {
  const { payload, headers } = signWebhook(
    payoutResult({ payoutId, result, ...(bankTxnId ? { bankTxnId } : {}) }),
    testConfig.bankWebhookSecret,
    h.clock,
  );
  return request(app).post("/v1/bank/webhooks").set(headers).send(payload);
}

async function resolve(payoutId: string, action: string, opsId = randomUUID()) {
  return request(app)
    .post(`/v1/ops/payouts/${payoutId}/resolve`)
    .set("Authorization", await bearer("ops", h.clock, opsId))
    .set("Idempotency-Key", randomUUID())
    .send({ action, note: `ops checked with the bank: ${action}` });
}

/** Active account with debt, then a repayment that overpays by `excess`. */
async function withCredit(excess: number) {
  const acc = await activeAccount(app, h, 100_000);
  const auth = authorization({ cardToken: acc.cardToken, amount: 20_000 });
  await authorize(app, auth);
  await network("/captures", {
    networkCaptureId: `cap_${randomUUID()}`,
    networkAuthId: auth.networkAuthId,
    cardToken: acc.cardToken,
    amount: 20_000,
    currency: "MXN",
  });
  const res = await bankTransfer(app, h.clock, {
    reference: acc.view.repaymentReference,
    amount: 20_000 + excess,
  });
  expect(res.body.outcome).toBe("repayment_applied");
  return acc;
}

describe("repayment", () => {
  it("REPAY-02: a repayment reduces the debt and restores available credit", async () => {
    const acc = await activeAccount(app, h, 100_000);
    const auth = authorization({ cardToken: acc.cardToken, amount: 60_000 });
    await authorize(app, auth);
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId: auth.networkAuthId,
      cardToken: acc.cardToken,
      amount: 60_000,
      currency: "MXN",
    });
    expect((await view(acc.view.id)).availableCredit).toBe(40_000);

    await bankTransfer(app, h.clock, { reference: acc.view.repaymentReference, amount: 25_000 });
    expect(await view(acc.view.id)).toMatchObject({
      postedDebt: 35_000,
      availableCredit: 65_000,
      creditBalance: 0,
    });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("REPAY-03 / SPEND-12: an overpayment becomes credit, not extra available credit", async () => {
    const acc = await withCredit(15_000);
    expect(await view(acc.view.id)).toMatchObject({
      postedDebt: 0,
      creditBalance: 15_000,
      availableCredit: 100_000,
    });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("REPAY-01: an unsigned repayment is rejected", async () => {
    const acc = await activeAccount(app, h, 100_000);
    const res = await request(app)
      .post("/v1/bank/webhooks")
      .send({
        type: "transfer.received",
        bankTxnId: `spei_${randomUUID()}`,
        reference: acc.view.repaymentReference,
        amount: 1_000,
        currency: "MXN",
      });
    expect(res.status).toBe(401);
  });
});

describe("PAYOUT-10: credit nets against new debt until a payout takes it", () => {
  it("a capture uses free credit first", async () => {
    const acc = await withCredit(15_000);
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 10_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 0, creditBalance: 5_000 });

    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 8_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 3_000, creditBalance: 0 });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("credit in a sent payout does not net", async () => {
    const acc = await withCredit(15_000);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 10_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 10_000, creditBalance: 15_000 });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("PAYOUT-11 / D-M6-1: a credited collateral deposit never nets; it is returned", async () => {
    const acc = await activeAccount(app, h, 100_000);
    await bankTransfer(app, h.clock, { reference: acc.view.collateralReference, amount: 30_000 });
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 10_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 10_000, creditBalance: 30_000 });

    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [ret] = await payoutsOf(acc.view.id);
    expect(ret).toMatchObject({ kind: "return", amount: 30_000, sourceCash: "cash_collateral" });
  });
});

describe("payout lifecycle", () => {
  it("REPAY-04 / PAYOUT-05 / PAYOUT-12 / PAYOUT-13: the job reserves credit and pays to the customer's CLABE; the ledger moves only on completion", async () => {
    const acc = await withCredit(15_000);
    const before = h.bank.requests.length;
    const result = await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    expect(result).toEqual({ created: 1, statuses: ["requested"] });
    expect(h.bank.requests.slice(before)).toEqual([
      expect.objectContaining({
        amount: 15_000,
        sourceAccount: "cash_operating",
        destinationClabe: PAYOUT_CLABE,
      }),
    ]);
    const [payout] = await payoutsOf(acc.view.id);
    expect(payout).toMatchObject({ kind: "credit", status: "requested", amount: 15_000 });
    // Reserved, not paid: the credit balance is still on the books.
    expect((await view(acc.view.id)).creditBalance).toBe(15_000);

    const res = await bankResult(payout!.id, "completed");
    expect(res.body).toMatchObject({ outcome: "payout_result_applied", duplicate: false });
    expect((await view(acc.view.id)).creditBalance).toBe(0);
    expect((await payoutsOf(acc.view.id))[0]!.status).toBe("completed");
    await expectAccountConsistent(h, acc.view.id);
  });

  it("PAYOUT-06: the bank gets our payout ID as its idempotency key", async () => {
    const acc = await withCredit(1_000);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    expect(h.bank.requests.at(-1)!.payoutId).toBe(payout!.id);
  });

  it("running the job twice, even in parallel, creates one payout", async () => {
    const acc = await withCredit(7_000);
    await Promise.all([
      sendDuePayouts(h.deps, { accountIds: [acc.view.id] }),
      sendDuePayouts(h.deps, { accountIds: [acc.view.id] }),
    ]);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    expect(await payoutsOf(acc.view.id)).toHaveLength(1);
  });

  it("PAYOUT-02 / PAYOUT-03: a timeout makes the payout unknown and nothing retries it", async () => {
    const acc = await withCredit(9_000);
    h.bank.mode = "timeout";
    const result = await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    expect(result.statuses).toEqual(["unknown"]);

    h.bank.mode = "accept";
    const sent = h.bank.requests.length;
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    expect(h.bank.requests.length).toBe(sent); // no automatic retry
    expect(await payoutsOf(acc.view.id)).toEqual([expect.objectContaining({ status: "unknown" })]);
    // Still reserved: a new capture cannot net it.
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 9_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 9_000, creditBalance: 9_000 });
  });

  it("a clear rejection makes the payout failed; the money stays reserved", async () => {
    const acc = await withCredit(4_000);
    h.bank.mode = "reject";
    expect((await sendDuePayouts(h.deps, { accountIds: [acc.view.id] })).statuses).toEqual([
      "failed",
    ]);
    expect((await view(acc.view.id)).creditBalance).toBe(4_000);
  });
});

describe("PAYOUT-04: ops resolution", () => {
  it("ops completes an unknown payout after checking with the bank", async () => {
    const acc = await withCredit(9_000);
    h.bank.mode = "timeout";
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    const opsId = randomUUID();
    const res = await resolve(payout!.id, "completed", opsId);
    expect(res.status).toBe(200);
    expect(res.body.payout).toMatchObject({ status: "completed", resolvedBy: opsId });
    expect((await view(acc.view.id)).creditBalance).toBe(0);
    await expectAccountConsistent(h, acc.view.id);

    const audit = await h.pool.query<{ actor_type: string; action: string }>(
      "SELECT actor_type, action FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [payout!.id],
    );
    expect(audit.rows.at(-1)).toEqual({ actor_type: "ops", action: "payout.completed" });
  });

  it("PAYOUT-01 / PAYOUT-15: ops retries a failed payout; cancel parks the credit until release", async () => {
    const acc = await withCredit(6_000);
    h.bank.mode = "reject";
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);

    h.bank.mode = "accept";
    const retry = await resolve(payout!.id, "retry");
    expect(retry.status).toBe(200);
    expect(h.bank.requests.at(-1)!.payoutId).toBe(payout!.id);
    expect((await payoutsOf(acc.view.id))[0]!.status).toBe("requested");

    // The bank fails it again; ops gives up. The credit is parked: it does
    // not net and the job does not pay it out again.
    await bankResult(payout!.id, "failed");
    expect((await resolve(payout!.id, "cancel")).body.payout).toMatchObject({
      status: "cancelled",
      parked: true,
    });
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken: acc.cardToken,
      amount: 6_000,
      currency: "MXN",
    });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 6_000, creditBalance: 6_000 });
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    expect(await payoutsOf(acc.view.id)).toHaveLength(1);

    // Release: the freed credit pays the debt first (A2).
    const released = await request(app)
      .post(`/v1/ops/payouts/${payout!.id}/release`)
      .set("Authorization", await bearer("ops", h.clock))
      .set("Idempotency-Key", randomUUID())
      .send({ note: "customer confirmed a new account" });
    expect(released.body.payout).toMatchObject({ parked: false });
    expect(await view(acc.view.id)).toMatchObject({ postedDebt: 0, creditBalance: 0 });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("an action that does not fit the state is 409; customers cannot resolve", async () => {
    const acc = await withCredit(2_000);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    expect((await resolve(payout!.id, "retry")).status).toBe(409);
    const asCustomer = await request(app)
      .post(`/v1/ops/payouts/${payout!.id}/resolve`)
      .set("Authorization", acc.auth)
      .set("Idempotency-Key", randomUUID())
      .send({ action: "completed", note: "x" });
    expect(asCustomer.status).toBe(403);
  });
});

describe("PAYOUT-08 / PAYOUT-09: late bank results", () => {
  it("a late result resolves an unknown payout", async () => {
    const acc = await withCredit(3_000);
    h.bank.mode = "timeout";
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    const res = await bankResult(payout!.id, "completed");
    expect(res.body.outcome).toBe("payout_result_applied");
    expect((await payoutsOf(acc.view.id))[0]!.status).toBe("completed");
  });

  it("after a person resolved it, an agreeing result changes nothing", async () => {
    const acc = await withCredit(3_000);
    h.bank.mode = "timeout";
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    await resolve(payout!.id, "completed");
    const res = await bankResult(payout!.id, "completed");
    expect(res.body.outcome).toBe("payout_result_ignored");
    expect((await payoutsOf(acc.view.id))[0]).toMatchObject({
      status: "completed",
      mismatch: false,
    });
    await expectAccountConsistent(h, acc.view.id);
  });

  it("after a person resolved it, a different result is flagged and changes nothing", async () => {
    const acc = await withCredit(3_000);
    h.bank.mode = "timeout";
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    await resolve(payout!.id, "failed");

    const res = await bankResult(payout!.id, "completed");
    expect(res.body.outcome).toBe("payout_result_mismatch");
    expect((await payoutsOf(acc.view.id))[0]).toMatchObject({ status: "failed", mismatch: true });
    expect((await view(acc.view.id)).creditBalance).toBe(3_000); // ledger untouched

    const flagged = await request(app)
      .get("/v1/ops/payouts?mismatch=true")
      .set("Authorization", await bearer("ops", h.clock));
    expect((flagged.body as { payouts: PayoutView[] }).payouts.map((p) => p.id)).toContain(
      payout!.id,
    );
  });

  it("a duplicate bank result is processed once", async () => {
    const acc = await withCredit(5_000);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    const bankTxnId = `spei_out_${randomUUID()}`;
    await bankResult(payout!.id, "completed", bankTxnId);
    const dup = await bankResult(payout!.id, "completed", bankTxnId);
    expect(dup.body).toMatchObject({ outcome: "payout_result_applied", duplicate: true });
    expect((await view(acc.view.id)).creditBalance).toBe(0);
    await expectAccountConsistent(h, acc.view.id);
  });

  it("10 overlapping deliveries of one result complete the payout once", async () => {
    const acc = await withCredit(5_000);
    await sendDuePayouts(h.deps, { accountIds: [acc.view.id] });
    const [payout] = await payoutsOf(acc.view.id);
    const server = await listen(app);
    try {
      const { payload, headers } = signWebhook(
        payoutResult({ payoutId: payout!.id, result: "completed" }),
        testConfig.bankWebhookSecret,
        h.clock,
      );
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${server.url}/v1/bank/webhooks`, { method: "POST", headers, body: payload }).then(
            (r) => r.status,
          ),
        ),
      );
      expect(statuses).toEqual(Array(10).fill(200));
      expect((await view(acc.view.id)).creditBalance).toBe(0);
      await expectAccountConsistent(h, acc.view.id);
    } finally {
      await server.close();
    }
  });
});

describe("COL-08: unapplied funds for ops", () => {
  it("lists money with an unknown reference", async () => {
    const bankTxnId = `spei_${randomUUID()}`;
    await bankTransfer(app, h.clock, { reference: "111111111111111111", amount: 7_700, bankTxnId });
    const res = await request(app)
      .get("/v1/ops/unapplied-funds")
      .set("Authorization", await bearer("ops", h.clock));
    expect(res.body.unapplied).toContainEqual(
      expect.objectContaining({ bankTxnId, amount: 7_700 }),
    );
  });
});

describe("Q24", () => {
  it("the whole ledger still sums to zero", async () => {
    expect(await h.deps.ledger.trialBalance(h.pool)).toBe(0);
  });
});
