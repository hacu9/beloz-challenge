import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import {
  activeAccount,
  authorization,
  authorize,
  bankTransfer,
  bearer,
  getAccount,
  openAccount,
} from "../support/actors.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();
const DAY_MS = 24 * 60 * 60 * 1000;

/** held_total equals the sum of open holds (Q25), read straight from the tables. */
async function holdState(accountId: string) {
  const { rows } = await h.pool.query<{ held_total: number; open_sum: number; open_count: number }>(
    `SELECT a.held_total,
            coalesce(sum(hd.amount) FILTER (WHERE hd.status = 'open'), 0)::bigint AS open_sum,
            count(hd.id) FILTER (WHERE hd.status = 'open')::int AS open_count
     FROM accounts a LEFT JOIN holds hd ON hd.account_id = a.id
     WHERE a.id = $1 GROUP BY a.id`,
    [accountId],
  );
  return rows[0]!;
}

async function journalCount(accountId: string): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM journal_entries WHERE account_id = $1",
    [accountId],
  );
  return rows[0]!.n;
}

describe("authorization", () => {
  it("SPEND-01: requires the network key", async () => {
    const res = await request(app)
      .post("/v1/network/authorizations")
      .send(authorization({ cardToken: "tok_x", amount: 100 }));
    expect(res.status).toBe(401);
  });

  it("SPEND-02 / SPEND-04: approves within available credit and creates a hold", async () => {
    const { auth, view, cardToken } = await activeAccount(app, h, 100_000);
    const res = await authorize(app, authorization({ cardToken, amount: 25_000 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, declineReason: null, duplicate: false });
    expect(res.body.holdId).toEqual(expect.any(String));

    const after = (await getAccount(app, auth, view.id)).body as AccountView;
    expect(after).toMatchObject({ heldTotal: 25_000, availableCredit: 75_000, postedDebt: 0 });
    const state = await holdState(view.id);
    expect(state.held_total).toBe(state.open_sum);
  });

  it("SPEND-02: the exact available amount is approved; one centavo more is declined", async () => {
    const { cardToken } = await activeAccount(app, h, 100_000);
    expect((await authorize(app, authorization({ cardToken, amount: 60_000 }))).body.approved).toBe(
      true,
    );
    const over = await authorize(app, authorization({ cardToken, amount: 40_001 }));
    expect(over.body).toMatchObject({
      approved: false,
      declineReason: "insufficient_credit",
      holdId: null,
    });
    expect((await authorize(app, authorization({ cardToken, amount: 40_000 }))).body.approved).toBe(
      true,
    );
  });

  it("LEDGER-05: an authorization writes nothing to the ledger", async () => {
    const { view, cardToken } = await activeAccount(app, h, 100_000);
    const before = await journalCount(view.id);
    await authorize(app, authorization({ cardToken, amount: 10_000 }));
    expect(await journalCount(view.id)).toBe(before);
  });

  it("SPEND-03: 20 parallel purchases never exceed the limit", async () => {
    const { view, cardToken } = await activeAccount(app, h, 100_000);
    const server = await listen(app);
    try {
      // 20 x 7,000 = 140,000 asked against 100,000: exactly 14 fit.
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          fetch(`${server.url}/v1/network/authorizations`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-network-key": testConfig.networkApiKey,
            },
            body: JSON.stringify(authorization({ cardToken, amount: 7_000 })),
          }).then(async (r) => ({
            status: r.status,
            body: (await r.json()) as { approved: boolean },
          })),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
      const approved = results.filter((r) => r.body.approved).length;
      expect(approved).toBe(14);

      const state = await holdState(view.id);
      expect(state.open_count).toBe(14);
      expect(state.held_total).toBe(98_000);
      expect(state.held_total).toBe(state.open_sum);
      expect(state.held_total).toBeLessThanOrEqual(100_000);
    } finally {
      await server.close();
    }
  });

  it("SPEND-12: a credit balance does not raise available credit above the limit", async () => {
    const { auth, view, cardToken } = await activeAccount(app, h, 100_000);
    // A second collateral transfer is credited for payback, not added to the limit.
    await bankTransfer(app, h.clock, { reference: view.collateralReference, amount: 30_000 });
    const after = (await getAccount(app, auth, view.id)).body as AccountView;
    expect(after).toMatchObject({
      creditLimit: 100_000,
      creditBalance: 30_000,
      availableCredit: 100_000,
    });

    const over = await authorize(app, authorization({ cardToken, amount: 100_001 }));
    expect(over.body).toMatchObject({ approved: false, declineReason: "insufficient_credit" });
    expect(
      (await authorize(app, authorization({ cardToken, amount: 100_000 }))).body.approved,
    ).toBe(true);
  });

  it("COL-05 / SPEND-05: a card on a pending_collateral account is declined", async () => {
    const auth = await bearer("customer", h.clock);
    const view = await openAccount(app, auth);
    const { rows } = await h.pool.query<{ token: string }>(
      "SELECT token FROM cards WHERE account_id = $1",
      [view.id],
    );
    const res = await authorize(app, authorization({ cardToken: rows[0]!.token, amount: 100 }));
    expect(res.body).toMatchObject({ approved: false, declineReason: "account_not_active" });
  });

  it("SPEND-05 / SPEND-13: an unknown card and an amount over the maximum are declined", async () => {
    const unknown = await authorize(app, authorization({ cardToken: "tok_unknown", amount: 100 }));
    expect(unknown.body).toMatchObject({ approved: false, declineReason: "card_not_found" });

    const { cardToken } = await activeAccount(app, h, 100_000);
    const huge = await authorize(
      app,
      authorization({ cardToken, amount: testConfig.maxAmountCentavos + 1 }),
    );
    expect(huge.body).toMatchObject({ approved: false, declineReason: "amount_over_maximum" });
  });

  it("rejects a malformed request (fractional amount, other currency) with 422", async () => {
    const { cardToken } = await activeAccount(app, h, 100_000);
    for (const body of [
      { ...authorization({ cardToken, amount: 100 }), amount: 10.5 },
      { ...authorization({ cardToken, amount: 100 }), currency: "USD" },
    ]) {
      const res = await request(app)
        .post("/v1/network/authorizations")
        .set("X-Network-Key", testConfig.networkApiKey)
        .send(body);
      expect(res.status).toBe(422);
    }
  });
});

describe("SPEND-11: one decision per network authorization ID", () => {
  it("a retried approval returns the same hold and holds nothing twice", async () => {
    const { view, cardToken } = await activeAccount(app, h, 100_000);
    const body = authorization({ cardToken, amount: 30_000 });
    const first = await authorize(app, body);
    const retry = await authorize(app, body);
    expect(retry.body).toEqual({ ...first.body, duplicate: true });
    expect((await holdState(view.id)).held_total).toBe(30_000);
  });

  it("a retried decline returns the same decline, even after credit frees up", async () => {
    const { cardToken } = await activeAccount(app, h, 100_000);
    const body = authorization({ cardToken, amount: 150_000 });
    expect((await authorize(app, body)).body.declineReason).toBe("insufficient_credit");
    expect((await authorize(app, body)).body).toMatchObject({
      approved: false,
      declineReason: "insufficient_credit",
      duplicate: true,
    });
  });

  it("the same ID with a different amount is a 409 conflict", async () => {
    const { cardToken } = await activeAccount(app, h, 100_000);
    const networkAuthId = `auth_${randomUUID()}`;
    await authorize(app, authorization({ cardToken, amount: 1_000, networkAuthId }));
    const res = await authorize(app, authorization({ cardToken, amount: 2_000, networkAuthId }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("network_auth_conflict");
  });

  it("10 overlapping deliveries of one authorization create one hold", async () => {
    const { view, cardToken } = await activeAccount(app, h, 100_000);
    const server = await listen(app);
    try {
      const payload = JSON.stringify(authorization({ cardToken, amount: 5_000 }));
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${server.url}/v1/network/authorizations`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-network-key": testConfig.networkApiKey,
            },
            body: payload,
          }).then(async (r) => ({
            status: r.status,
            body: (await r.json()) as { holdId: string },
          })),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(new Set(results.map((r) => r.body.holdId)).size).toBe(1);
      expect(await holdState(view.id)).toMatchObject({ open_count: 1, held_total: 5_000 });
    } finally {
      await server.close();
    }
  });
});

describe("SPEND-09: hold expiry", () => {
  it("a hold blocks credit until exactly HOLD_TTL_DAYS, then stops counting", async () => {
    const { view, cardToken } = await activeAccount(app, h, 100_000);
    const first = await authorize(app, authorization({ cardToken, amount: 100_000 }));
    expect(first.body.approved).toBe(true);

    h.clock.advanceMs(testConfig.holdTtlDays * DAY_MS - 1);
    expect((await authorize(app, authorization({ cardToken, amount: 1 }))).body.declineReason).toBe(
      "insufficient_credit",
    );

    h.clock.advanceMs(1);
    const second = await authorize(app, authorization({ cardToken, amount: 100_000 }));
    expect(second.body.approved).toBe(true);

    const { rows } = await h.pool.query<{ status: string }>(
      "SELECT status FROM holds WHERE id = $1",
      [first.body.holdId],
    );
    expect(rows[0]!.status).toBe("expired");
    expect(await holdState(view.id)).toMatchObject({ open_count: 1, held_total: 100_000 });
    // The customer token from before the 7 days has expired; read as ops.
    const ops = await bearer("ops", h.clock);
    expect(((await getAccount(app, ops, view.id)).body as AccountView).availableCredit).toBe(0);

    const audit = await h.pool.query("SELECT action FROM audit_log WHERE entity_id = $1", [
      first.body.holdId,
    ]);
    expect(audit.rows).toEqual([{ action: "hold.expired" }]);
  });
});
