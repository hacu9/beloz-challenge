import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { payoutResult, signWebhook } from "../../src/fakes/fake-bank.js";
import { progressClosures } from "../../src/jobs/progress-closures.js";
import { sendDuePayouts } from "../../src/jobs/send-payouts.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { withTx } from "../../src/platform/db/tx.js";
import { createHarness, testConfig } from "../support/harness.js";
import {
  activeAccount,
  authorization,
  authorize,
  bankTransfer,
  bearer,
  getAccount,
  openAccount,
} from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => {
  h.bank.mode = "accept";
});
const app = h.app();
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = testConfig.closingCaptureWindowDays * DAY_MS;

interface PayoutView {
  id: string;
  kind: string;
  amount: number;
  status: string;
  sourceCash: string;
  stuckReason: string | null;
}

const network = (path: string, body: object) =>
  request(app).post(`/v1/network${path}`).set("X-Network-Key", testConfig.networkApiKey).send(body);

const capture = (cardToken: string, amount: number, networkAuthId?: string) =>
  network("/captures", {
    networkCaptureId: `cap_${randomUUID()}`,
    ...(networkAuthId ? { networkAuthId } : {}),
    cardToken,
    amount,
    currency: "MXN",
  });

async function spend(cardToken: string, amount: number) {
  const auth = authorization({ cardToken, amount });
  expect((await authorize(app, auth)).body.approved).toBe(true);
  expect((await capture(cardToken, amount, auth.networkAuthId)).status).toBe(200);
}

async function close(accountId: string, auth: string) {
  return request(app)
    .post(`/v1/accounts/${accountId}/close`)
    .set("Authorization", auth)
    .set("Idempotency-Key", randomUUID())
    .send({});
}

async function view(accountId: string): Promise<AccountView> {
  return (await getAccount(app, await bearer("ops", h.clock), accountId)).body as AccountView;
}

async function payoutsOf(accountId: string, query = ""): Promise<PayoutView[]> {
  const res = await request(app)
    .get(`/v1/ops/payouts?accountId=${accountId}${query}`)
    .set("Authorization", await bearer("ops", h.clock));
  return (res.body as { payouts: PayoutView[] }).payouts;
}

/** The bank confirms every requested payout of the account. */
async function bankCompletesAll(accountId: string) {
  for (const p of await payoutsOf(accountId, "&status=requested,unknown")) {
    const { payload, headers } = signWebhook(
      payoutResult({ payoutId: p.id, result: "completed" }),
      testConfig.bankWebhookSecret,
      h.clock,
    );
    expect((await request(app).post("/v1/bank/webhooks").set(headers).send(payload)).status).toBe(
      200,
    );
  }
}

const progress = (accountId: string) => progressClosures(h.deps, { accountIds: [accountId] });

async function ledgerLines(accountId: string, kind: string) {
  const { rows } = await h.pool.query<{ code: string; amount: number }>(
    `SELECT la.code, jl.amount FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_id = je.id
     JOIN ledger_accounts la ON la.id = jl.ledger_account_id
     WHERE je.account_id = $1 AND je.kind = $2 ORDER BY la.code`,
    [accountId, kind],
  );
  return rows;
}

describe("close request", () => {
  it("CLOSE-01: closing blocks new purchases at once and blocks the card", async () => {
    const a = await activeAccount(app, h, 100_000);
    const res = await close(a.view.id, a.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "closing", card: { status: "blocked" } });
    const auth = await authorize(app, authorization({ cardToken: a.cardToken, amount: 100 }));
    expect(auth.body).toMatchObject({ approved: false, declineReason: "account_not_active" });
  });

  it("CLOSE-01: a second close is 409; another customer gets 404; ops may close", async () => {
    const a = await activeAccount(app, h, 100_000);
    expect((await close(a.view.id, await bearer("customer", h.clock))).status).toBe(404);
    expect((await close(a.view.id, await bearer("ops", h.clock))).status).toBe(200);
    const again = await close(a.view.id, a.auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("account_not_closable");
  });

  it("an empty pending account closes at once", async () => {
    const auth = await bearer("customer", h.clock);
    const v = await openAccount(app, auth);
    expect((await close(v.id, auth)).body.status).toBe("closed");
  });
});

describe("closure in good standing", () => {
  it("CLOSE-02..06: late capture posts, collateral pays the debt, the rest goes back, then closed", async () => {
    const a = await activeAccount(app, h, 100_000);
    await spend(a.cardToken, 30_000);
    await close(a.view.id, a.auth);

    // CLOSE-03: inside the late-capture window nothing moves.
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closing");

    // CLOSE-02: a late capture still posts.
    expect((await capture(a.cardToken, 5_000)).status).toBe(200);
    expect((await view(a.view.id)).postedDebt).toBe(35_000);

    h.clock.advanceMs(WINDOW_MS);
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({
      status: "settling",
      postedDebt: 0,
      creditLimit: 65_000,
    });
    expect(await ledgerLines(a.view.id, "collateral_application")).toEqual([
      { code: "cash_collateral", amount: -35_000 },
      { code: "cash_operating", amount: 35_000 },
      { code: "customer_collateral", amount: 35_000 },
      { code: "customer_receivable", amount: -35_000 },
    ]);
    const [payout] = await payoutsOf(a.view.id);
    expect(payout).toMatchObject({
      kind: "collateral",
      amount: 65_000,
      status: "requested",
      sourceCash: "cash_collateral",
    });
    await expectAccountConsistent(h, a.view.id);

    // CLOSE-05: closed only after the bank confirms the payout.
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("settling");
    await bankCompletesAll(a.view.id);
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({ status: "closed", creditLimit: 0 });
    await expectAccountConsistent(h, a.view.id);
  });

  it("free credit pays the debt before collateral is applied", async () => {
    const a = await activeAccount(app, h, 100_000);
    await spend(a.cardToken, 20_000);
    await bankTransfer(app, h.clock, { reference: a.view.repaymentReference, amount: 30_000 });
    await spend(a.cardToken, 4_000); // nets 4,000 of the 10,000 credit
    await close(a.view.id, a.auth);
    h.clock.advanceMs(WINDOW_MS);
    await progress(a.view.id);
    const payouts = await payoutsOf(a.view.id);
    expect(payouts.map((p) => [p.kind, p.amount]).sort()).toEqual([
      ["collateral", 100_000],
      ["credit", 6_000],
    ]);
    await bankCompletesAll(a.view.id);
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closed");
    await expectAccountConsistent(h, a.view.id);
  });

  it("a pending account with a credited deposit returns it, then closes, without the window", async () => {
    const auth = await bearer("customer", h.clock);
    const v = await openAccount(app, auth);
    await bankTransfer(app, h.clock, {
      reference: v.collateralReference,
      amount: testConfig.minDepositCentavos - 1,
    });
    expect((await close(v.id, auth)).body.status).toBe("closing");
    await progress(v.id);
    expect((await view(v.id)).status).toBe("settling");
    expect(await payoutsOf(v.id)).toEqual([expect.objectContaining({ kind: "return" })]);
    await bankCompletesAll(v.id);
    await progress(v.id);
    expect((await view(v.id)).status).toBe("closed");
    await expectAccountConsistent(h, v.id);
  });
});

describe("debt larger than collateral", () => {
  it("CLOSE-07: applies all collateral and charges off the rest for collections", async () => {
    const a = await activeAccount(app, h, 100_000);
    const auth = authorization({ cardToken: a.cardToken, amount: 90_000 });
    await authorize(app, auth);
    await capture(a.cardToken, 130_000, auth.networkAuthId); // SPEND-06: over the limit
    await close(a.view.id, a.auth);
    h.clock.advanceMs(WINDOW_MS);
    await progress(a.view.id);

    expect(await view(a.view.id)).toMatchObject({
      status: "closed",
      postedDebt: 0,
      creditLimit: 0,
      chargedOffOutstanding: 30_000,
    });
    expect(await payoutsOf(a.view.id)).toEqual([]); // CLOSE-06: no collateral back
    expect(await ledgerLines(a.view.id, "chargeoff")).toEqual([
      { code: "chargeoff_loss", amount: 30_000 },
      { code: "customer_receivable", amount: -30_000 },
    ]);
    await expectAccountConsistent(h, a.view.id);
  });

  it("CLOSE-09: a later repayment recovers the charge-off first; only the excess is paid back", async () => {
    const a = await activeAccount(app, h, 100_000);
    await capture(a.cardToken, 125_000);
    await close(a.view.id, a.auth);
    h.clock.advanceMs(WINDOW_MS);
    await progress(a.view.id);
    expect((await view(a.view.id)).chargedOffOutstanding).toBe(25_000);

    await bankTransfer(app, h.clock, { reference: a.view.repaymentReference, amount: 40_000 });
    expect(await view(a.view.id)).toMatchObject({
      chargedOffOutstanding: 0,
      creditBalance: 15_000,
    });
    const { rows } = await h.pool.query<{ kind: string; amount: number }>(
      "SELECT kind, amount FROM charge_offs WHERE account_id = $1 ORDER BY created_at, kind",
      [a.view.id],
    );
    expect(rows).toEqual([
      { kind: "charge_off", amount: 25_000 },
      { kind: "recovery", amount: 25_000 },
    ]);

    // CLOSE-08: the excess on a closed account is paid back.
    await progress(a.view.id);
    expect(await payoutsOf(a.view.id)).toEqual([
      expect.objectContaining({ kind: "credit", amount: 15_000 }),
    ]);
    await expectAccountConsistent(h, a.view.id);
  });

  it("CLOSE-08: a capture after closed posts and is charged off", async () => {
    const a = await activeAccount(app, h, 100_000);
    await close(a.view.id, a.auth);
    h.clock.advanceMs(WINDOW_MS);
    await progress(a.view.id);
    await bankCompletesAll(a.view.id);
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closed");

    expect((await capture(a.cardToken, 8_000)).status).toBe(200);
    await progress(a.view.id);
    expect(await view(a.view.id)).toMatchObject({
      status: "closed",
      postedDebt: 0,
      chargedOffOutstanding: 8_000,
    });
    await expectAccountConsistent(h, a.view.id);
  });
});

describe("PAYOUT-07: closed waits for every payout", () => {
  it("an unknown collateral payout keeps the account settling until ops resolves it", async () => {
    const a = await activeAccount(app, h, 100_000);
    await close(a.view.id, a.auth);
    h.clock.advanceMs(WINDOW_MS);
    h.bank.mode = "timeout";
    await progress(a.view.id);
    const [payout] = await payoutsOf(a.view.id);
    expect(payout!.status).toBe("unknown");

    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("settling");
    expect(await payoutsOf(a.view.id)).toHaveLength(1); // no second collateral payout

    const resolved = await request(app)
      .post(`/v1/ops/payouts/${payout!.id}/resolve`)
      .set("Authorization", await bearer("ops", h.clock))
      .set("Idempotency-Key", randomUUID())
      .send({ action: "completed", note: "bank statement shows the transfer" });
    expect(resolved.status).toBe(200);
    await progress(a.view.id);
    expect((await view(a.view.id)).status).toBe("closed");
    await expectAccountConsistent(h, a.view.id);
  });
});

describe("PAYOUT-14: stuck payouts are flagged for ops", () => {
  it("flags a requested payout that was never submitted, after PAYOUT_STUCK_MINUTES", async () => {
    const a = await activeAccount(app, h, 100_000);
    await bankTransfer(app, h.clock, { reference: a.view.collateralReference, amount: 9_000 });
    // Simulates a crash between the commit and the bank call.
    await withTx(h.pool, (tx) => h.deps.payouts.createDue(tx, a.view.id));

    h.clock.advanceMs((testConfig.payoutStuckMinutes - 1) * 60_000);
    expect((await payoutsOf(a.view.id))[0]!.stuckReason).toBeNull();
    h.clock.advanceMs(60_000);
    expect((await payoutsOf(a.view.id))[0]!.stuckReason).toBe("not_submitted");
    expect(await payoutsOf(a.view.id, "&stuck=true")).toHaveLength(1);
  });

  it("flags a submitted payout with no bank result", async () => {
    const a = await activeAccount(app, h, 100_000);
    await bankTransfer(app, h.clock, { reference: a.view.collateralReference, amount: 9_000 });
    await sendDuePayouts(h.deps, { accountIds: [a.view.id] });
    expect(await payoutsOf(a.view.id, "&stuck=true")).toEqual([]);
    h.clock.advanceMs(testConfig.payoutStuckMinutes * 60_000);
    expect((await payoutsOf(a.view.id, "&stuck=true"))[0]!.stuckReason).toBe("no_bank_result");
  });
});

describe("Q24", () => {
  it("the whole ledger still sums to zero", async () => {
    expect(await h.deps.ledger.trialBalance(h.pool)).toBe(0);
  });
});
