import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { expireDueHolds } from "../../src/jobs/expire-holds.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import { activeAccount, authorization, authorize, bearer, getAccount } from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();
const DAY_MS = 24 * 60 * 60 * 1000;

const network = (app: Express, path: string, body?: object) =>
  request(app)
    .post(`/v1/network${path}`)
    .set("X-Network-Key", testConfig.networkApiKey)
    .send(body ?? {});

const captureBody = (args: {
  cardToken: string;
  amount: number;
  networkAuthId?: string;
  networkCaptureId?: string;
}) => ({
  networkCaptureId: args.networkCaptureId ?? `cap_${randomUUID()}`,
  ...(args.networkAuthId ? { networkAuthId: args.networkAuthId } : {}),
  cardToken: args.cardToken,
  amount: args.amount,
  currency: "MXN",
});

const refundBody = (args: { cardToken: string; amount: number; networkRefundId?: string }) => ({
  networkRefundId: args.networkRefundId ?? `ref_${randomUUID()}`,
  cardToken: args.cardToken,
  amount: args.amount,
  currency: "MXN",
});

/** Opens an active account and approves one authorization on it. */
async function withHold(collateral: number, holdAmount: number) {
  const acc = await activeAccount(app, h, collateral);
  const auth = authorization({ cardToken: acc.cardToken, amount: holdAmount });
  const res = await authorize(app, auth);
  expect(res.body.approved).toBe(true);
  return { ...acc, networkAuthId: auth.networkAuthId, holdId: res.body.holdId as string };
}

async function view(accountId: string): Promise<AccountView> {
  return (await getAccount(app, await bearer("ops", h.clock), accountId)).body as AccountView;
}

async function holdStatus(holdId: string): Promise<string> {
  const { rows } = await h.pool.query<{ status: string }>(
    "SELECT status FROM holds WHERE id = $1",
    [holdId],
  );
  return rows[0]!.status;
}

describe("capture", () => {
  it("SPEND-07: a capture of the hold amount closes the hold and posts the debt", async () => {
    const a = await withHold(100_000, 40_000);
    const res = await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 40_000, networkAuthId: a.networkAuthId }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ holdId: a.holdId, amount: 40_000, duplicate: false });
    expect(await holdStatus(a.holdId)).toBe("captured");
    expect(await view(a.view.id)).toMatchObject({
      heldTotal: 0,
      postedDebt: 40_000,
      availableCredit: 60_000,
    });
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-07: a smaller capture releases the whole hold and posts only the captured amount", async () => {
    const a = await withHold(100_000, 50_000);
    await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 30_000, networkAuthId: a.networkAuthId }),
    );
    expect(await view(a.view.id)).toMatchObject({
      heldTotal: 0,
      postedDebt: 30_000,
      availableCredit: 70_000,
    });
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-06 / SPEND-16: a capture larger than the hold posts in full and can push the account over its limit", async () => {
    const a = await withHold(100_000, 90_000);
    const res = await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 110_000, networkAuthId: a.networkAuthId }),
    );
    expect(res.status).toBe(200);
    // D-M5-2: the view clamps available credit at 0 and shows the excess.
    expect(await view(a.view.id)).toMatchObject({
      postedDebt: 110_000,
      availableCredit: 0,
      overLimit: 10_000,
    });
    expect(
      (await authorize(app, authorization({ cardToken: a.cardToken, amount: 1 }))).body
        .declineReason,
    ).toBe("insufficient_credit");
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-06: a capture after the hold expired still posts", async () => {
    const a = await withHold(100_000, 50_000);
    h.clock.advanceMs(testConfig.holdTtlDays * DAY_MS + 1);
    const res = await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 50_000, networkAuthId: a.networkAuthId }),
    );
    expect(res.status).toBe(200);
    expect(res.body.holdId).toBeNull();
    expect(await holdStatus(a.holdId)).toBe("expired");
    expect(await view(a.view.id)).toMatchObject({ heldTotal: 0, postedDebt: 50_000 });
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-14 / OQ-08: a force post without an authorization posts; an unknown card is 422", async () => {
    const a = await activeAccount(app, h, 100_000);
    const res = await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 12_000 }),
    );
    expect(res.status).toBe(200);
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 12_000 });

    const unknown = await network(
      app,
      "/captures",
      captureBody({ cardToken: "tok_nobody", amount: 100 }),
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("card_not_found");
    await expectAccountConsistent(h, a.view.id);
  });

  it("OQ-09: a second capture on the same authorization posts without touching holds", async () => {
    const a = await withHold(100_000, 20_000);
    await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 20_000, networkAuthId: a.networkAuthId }),
    );
    const second = await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 5_000, networkAuthId: a.networkAuthId }),
    );
    expect(second.status).toBe(200);
    expect(second.body.holdId).toBeNull();
    expect(await view(a.view.id)).toMatchObject({ heldTotal: 0, postedDebt: 25_000 });
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-11: a retried capture posts once; the same ID with other data is 409", async () => {
    const a = await withHold(100_000, 10_000);
    const body = captureBody({
      cardToken: a.cardToken,
      amount: 10_000,
      networkAuthId: a.networkAuthId,
    });
    const first = await network(app, "/captures", body);
    const retry = await network(app, "/captures", body);
    expect(retry.body).toEqual({ ...first.body, duplicate: true });
    expect(await view(a.view.id)).toMatchObject({ postedDebt: 10_000 });
    expect((await network(app, "/captures", { ...body, amount: 11_000 })).status).toBe(409);
  });

  it("SPEND-11: 10 overlapping deliveries of one capture post one journal", async () => {
    const a = await withHold(100_000, 10_000);
    const server = await listen(app);
    try {
      const payload = JSON.stringify(
        captureBody({ cardToken: a.cardToken, amount: 10_000, networkAuthId: a.networkAuthId }),
      );
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${server.url}/v1/network/captures`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-network-key": testConfig.networkApiKey,
            },
            body: payload,
          }).then((r) => r.status),
        ),
      );
      expect(statuses).toEqual(Array(10).fill(200));
      expect(await view(a.view.id)).toMatchObject({ postedDebt: 10_000, heldTotal: 0 });
      await expectAccountConsistent(h, a.view.id);
    } finally {
      await server.close();
    }
  });
});

describe("reversal", () => {
  it("SPEND-08: releases an open hold and writes no journal; a repeat changes nothing", async () => {
    const a = await withHold(100_000, 30_000);
    const journalsBefore = await h.pool.query(
      "SELECT 1 FROM journal_entries WHERE account_id = $1",
      [a.view.id],
    );
    const res = await network(app, `/authorizations/${a.networkAuthId}/reversal`);
    expect(res.body).toEqual({
      networkAuthId: a.networkAuthId,
      holdId: a.holdId,
      holdStatus: "reversed",
      released: 30_000,
    });
    expect(await view(a.view.id)).toMatchObject({ heldTotal: 0, availableCredit: 100_000 });

    const again = await network(app, `/authorizations/${a.networkAuthId}/reversal`);
    expect(again.body).toMatchObject({ holdStatus: "reversed", released: 0 });
    const journalsAfter = await h.pool.query(
      "SELECT 1 FROM journal_entries WHERE account_id = $1",
      [a.view.id],
    );
    expect(journalsAfter.rowCount).toBe(journalsBefore.rowCount);
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-15: a captured authorization cannot be reversed (409); an unknown one is 404", async () => {
    const a = await withHold(100_000, 30_000);
    await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 30_000, networkAuthId: a.networkAuthId }),
    );
    const res = await network(app, `/authorizations/${a.networkAuthId}/reversal`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("hold_already_captured");
    expect((await network(app, `/authorizations/auth_${randomUUID()}/reversal`)).status).toBe(404);
  });

  it("SPEND-15: reversing a declined authorization releases nothing", async () => {
    const a = await activeAccount(app, h, 100_000);
    const declined = authorization({ cardToken: a.cardToken, amount: 200_000 });
    await authorize(app, declined);
    const res = await network(app, `/authorizations/${declined.networkAuthId}/reversal`);
    expect(res.body).toMatchObject({ holdId: null, released: 0 });
  });

  it("a capture and a reversal racing on one hold leave the account consistent", async () => {
    const a = await withHold(100_000, 25_000);
    const server = await listen(app);
    try {
      const headers = {
        "content-type": "application/json",
        "x-network-key": testConfig.networkApiKey,
      };
      await Promise.all([
        fetch(`${server.url}/v1/network/captures`, {
          method: "POST",
          headers,
          body: JSON.stringify(
            captureBody({ cardToken: a.cardToken, amount: 25_000, networkAuthId: a.networkAuthId }),
          ),
        }),
        fetch(`${server.url}/v1/network/authorizations/${a.networkAuthId}/reversal`, {
          method: "POST",
          headers,
        }),
      ]);
      // Whichever came first, the hold is closed once and the capture posted once.
      expect(["captured", "reversed"]).toContain(await holdStatus(a.holdId));
      expect(await view(a.view.id)).toMatchObject({ heldTotal: 0, postedDebt: 25_000 });
      await expectAccountConsistent(h, a.view.id);
    } finally {
      await server.close();
    }
  });
});

describe("lost updates on the account counters", () => {
  it("a reversal racing new authorizations on the same account loses no held amount", async () => {
    const a = await withHold(200_000, 25_000);
    const server = await listen(app);
    try {
      const headers = {
        "content-type": "application/json",
        "x-network-key": testConfig.networkApiKey,
      };
      const auths = Array.from({ length: 6 }, () =>
        fetch(`${server.url}/v1/network/authorizations`, {
          method: "POST",
          headers,
          body: JSON.stringify(authorization({ cardToken: a.cardToken, amount: 5_000 })),
        }),
      );
      const reversal = fetch(
        `${server.url}/v1/network/authorizations/${a.networkAuthId}/reversal`,
        {
          method: "POST",
          headers,
        },
      );
      const statuses = (await Promise.all([reversal, ...auths])).map((r) => r.status);
      expect(statuses).toEqual(Array(7).fill(200));
      // 6 new holds of 5,000 stay; the reversed 25,000 is gone.
      expect(await view(a.view.id)).toMatchObject({ heldTotal: 30_000 });
      await expectAccountConsistent(h, a.view.id);
    } finally {
      await server.close();
    }
  });
});

describe("refund", () => {
  it("SPEND-10: a refund reduces the debt", async () => {
    const a = await withHold(100_000, 60_000);
    await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 60_000, networkAuthId: a.networkAuthId }),
    );
    const res = await network(
      app,
      "/refunds",
      refundBody({ cardToken: a.cardToken, amount: 20_000 }),
    );
    expect(res.body).toMatchObject({ debtReduced: 20_000, credited: 0 });
    expect(await view(a.view.id)).toMatchObject({
      postedDebt: 40_000,
      creditBalance: 0,
      availableCredit: 60_000,
    });
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-10 / SPEND-12: a refund above the debt credits the excess without raising available credit", async () => {
    const a = await withHold(100_000, 40_000);
    await network(
      app,
      "/captures",
      captureBody({ cardToken: a.cardToken, amount: 40_000, networkAuthId: a.networkAuthId }),
    );
    const res = await network(
      app,
      "/refunds",
      refundBody({ cardToken: a.cardToken, amount: 50_000 }),
    );
    expect(res.body).toMatchObject({ debtReduced: 40_000, credited: 10_000 });
    expect(await view(a.view.id)).toMatchObject({
      postedDebt: 0,
      creditBalance: 10_000,
      availableCredit: 100_000,
    });
    expect(
      (await authorize(app, authorization({ cardToken: a.cardToken, amount: 100_001 }))).body
        .declineReason,
    ).toBe("insufficient_credit");
    await expectAccountConsistent(h, a.view.id);
  });

  it("SPEND-11: a retried refund posts once; the same ID with another amount is 409", async () => {
    const a = await activeAccount(app, h, 100_000);
    const body = refundBody({ cardToken: a.cardToken, amount: 5_000 });
    const first = await network(app, "/refunds", body);
    expect((await network(app, "/refunds", body)).body).toEqual({ ...first.body, duplicate: true });
    expect(await view(a.view.id)).toMatchObject({ creditBalance: 5_000 });
    expect((await network(app, "/refunds", { ...body, amount: 6_000 })).status).toBe(409);
  });
});

describe("SPEND-09: expiry sweep job", () => {
  it("expires due holds so the account view is fresh without new activity", async () => {
    const a = await withHold(100_000, 70_000);
    h.clock.advanceMs(testConfig.holdTtlDays * DAY_MS);
    // Before the sweep the cached view still shows the overdue hold.
    expect(await view(a.view.id)).toMatchObject({ heldTotal: 70_000 });

    const result = await expireDueHolds(h.deps);
    expect(result.accounts).toBeGreaterThanOrEqual(1);
    expect(await holdStatus(a.holdId)).toBe("expired");
    expect(await view(a.view.id)).toMatchObject({ heldTotal: 0, availableCredit: 100_000 });
    await expectAccountConsistent(h, a.view.id);
  });
});

describe("Q24", () => {
  it("the whole ledger still sums to zero", async () => {
    expect(await h.deps.ledger.trialBalance(h.pool)).toBe(0);
  });
});
