import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
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
const app = h.app();

const act = (
  accountId: string,
  action: "freeze" | "unfreeze" | "close",
  auth: string,
  key = randomUUID(),
) =>
  request(app)
    .post(`/v1/accounts/${accountId}/${action}`)
    .set("Authorization", auth)
    .set("Idempotency-Key", key)
    .send({});

const network = (path: string, body: object) =>
  request(app).post(`/v1/network${path}`).set("X-Network-Key", testConfig.networkApiKey).send(body);

const view = async (id: string) =>
  (await getAccount(app, await bearer("ops", h.clock), id)).body as AccountView;

describe("FREEZE-01: who can freeze and unfreeze", () => {
  it("the customer freezes and unfreezes their own account", async () => {
    const a = await activeAccount(app, h, 100_000);
    const frozen = await act(a.view.id, "freeze", a.auth);
    expect(frozen.status).toBe(200);
    expect(frozen.body).toMatchObject({ status: "frozen", card: { status: "active" } });

    const unfrozen = await act(a.view.id, "unfreeze", a.auth);
    expect(unfrozen.body.status).toBe("active");

    const audit = await h.pool.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM audit_log
       WHERE entity_id = $1 AND action IN ('account.frozen', 'account.unfrozen') ORDER BY id`,
      [a.view.id],
    );
    expect(audit.rows).toEqual([
      { action: "account.frozen", actor_type: "customer" },
      { action: "account.unfrozen", actor_type: "customer" },
    ]);
  });

  it("ops can freeze and unfreeze any account; another customer gets 404", async () => {
    const a = await activeAccount(app, h, 100_000);
    const ops = await bearer("ops", h.clock);
    expect((await act(a.view.id, "freeze", await bearer("customer", h.clock))).status).toBe(404);
    expect((await act(a.view.id, "freeze", ops)).body.status).toBe("frozen");
    expect((await act(a.view.id, "unfreeze", ops)).body.status).toBe("active");
  });

  it("only active can freeze and only frozen can unfreeze (409 otherwise)", async () => {
    const a = await activeAccount(app, h, 100_000);
    expect((await act(a.view.id, "unfreeze", a.auth)).body.error.code).toBe("account_not_frozen");
    await act(a.view.id, "freeze", a.auth);
    expect((await act(a.view.id, "freeze", a.auth)).body.error.code).toBe("account_not_freezable");

    const auth = await bearer("customer", h.clock);
    const pending = await openAccount(app, auth);
    expect((await act(pending.id, "freeze", auth)).status).toBe(409);
  });

  it("IDEM-03: a retried freeze with the same key replays, it does not 409", async () => {
    const a = await activeAccount(app, h, 100_000);
    const key = randomUUID();
    expect((await act(a.view.id, "freeze", a.auth, key)).status).toBe(200);
    const again = await act(a.view.id, "freeze", a.auth, key);
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("FREEZE-02: frozen declines new purchases only", () => {
  it("a new purchase is declined with account_frozen, and approved again after unfreeze", async () => {
    const a = await activeAccount(app, h, 100_000);
    await act(a.view.id, "freeze", a.auth);
    const declined = await authorize(app, authorization({ cardToken: a.cardToken, amount: 1_000 }));
    expect(declined.body).toMatchObject({ approved: false, declineReason: "account_frozen" });

    await act(a.view.id, "unfreeze", a.auth);
    const approved = await authorize(app, authorization({ cardToken: a.cardToken, amount: 1_000 }));
    expect(approved.body.approved).toBe(true);
  });

  it("money that already moved still settles: capture, reversal, refund, repayment", async () => {
    const a = await activeAccount(app, h, 100_000);
    const toCapture = authorization({ cardToken: a.cardToken, amount: 30_000 });
    const toReverse = authorization({ cardToken: a.cardToken, amount: 10_000 });
    await authorize(app, toCapture);
    await authorize(app, toReverse);
    await act(a.view.id, "freeze", a.auth);

    const cap = await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId: toCapture.networkAuthId,
      cardToken: a.cardToken,
      amount: 30_000,
      currency: "MXN",
    });
    expect(cap.status).toBe(200);
    expect(
      (await network(`/authorizations/${toReverse.networkAuthId}/reversal`, {})).body,
    ).toMatchObject({
      released: 10_000,
    });
    expect(
      (
        await network("/refunds", {
          networkRefundId: `ref_${randomUUID()}`,
          cardToken: a.cardToken,
          amount: 5_000,
          currency: "MXN",
        })
      ).status,
    ).toBe(200);
    const repay = await bankTransfer(app, h.clock, {
      reference: a.view.repaymentReference,
      amount: 20_000,
    });
    expect(repay.body.outcome).toBe("repayment_applied");

    expect(await view(a.view.id)).toMatchObject({
      status: "frozen",
      heldTotal: 0,
      postedDebt: 5_000,
      creditBalance: 0,
    });
    await expectAccountConsistent(h, a.view.id);
  });

  it("FREEZE-03: a frozen account can be closed; closing blocks the card", async () => {
    const a = await activeAccount(app, h, 100_000);
    await act(a.view.id, "freeze", a.auth);
    const closed = await act(a.view.id, "close", a.auth);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: "closing", card: { status: "blocked" } });
    // Closing is final for purchases; unfreeze no longer applies.
    expect((await act(a.view.id, "unfreeze", a.auth)).status).toBe(409);
  });
});

describe("FREEZE-04: who froze it decides who can lift it (OQ-14)", () => {
  it("a customer cannot lift an ops freeze (403); ops can", async () => {
    const a = await activeAccount(app, h, 100_000);
    const ops = await bearer("ops", h.clock);
    expect((await act(a.view.id, "freeze", ops)).body).toMatchObject({
      status: "frozen",
      frozenBy: "ops",
    });
    const denied = await act(a.view.id, "unfreeze", a.auth);
    expect(denied.status).toBe(403);
    expect((await view(a.view.id)).status).toBe("frozen");
    expect((await act(a.view.id, "unfreeze", ops)).body).toMatchObject({
      status: "active",
      frozenBy: null,
    });
  });

  it("a customer lifts their own freeze; ops can lift it too", async () => {
    const a = await activeAccount(app, h, 100_000);
    expect((await act(a.view.id, "freeze", a.auth)).body.frozenBy).toBe("customer");
    expect((await act(a.view.id, "unfreeze", await bearer("ops", h.clock))).body.status).toBe(
      "active",
    );
  });

  it("ops escalates a customer freeze, so the customer can no longer lift it", async () => {
    const a = await activeAccount(app, h, 100_000);
    const ops = await bearer("ops", h.clock);
    await act(a.view.id, "freeze", a.auth); // lost wallet
    const escalated = await act(a.view.id, "freeze", ops); // then fraud suspicion
    expect(escalated.status).toBe(200);
    expect(escalated.body).toMatchObject({ status: "frozen", frozenBy: "ops" });
    expect((await act(a.view.id, "unfreeze", a.auth)).status).toBe(403);

    const audit = await h.pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'account.freeze%' ORDER BY id`,
      [a.view.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["account.freeze_escalated"]);
  });

  it("closing a frozen account clears frozen_by (the database requires it)", async () => {
    const a = await activeAccount(app, h, 100_000);
    await act(a.view.id, "freeze", await bearer("ops", h.clock));
    const closed = await act(a.view.id, "close", a.auth);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: "closing", frozenBy: null });
  });

  it("the database refuses frozen_by without the frozen status", async () => {
    const a = await activeAccount(app, h, 100_000);
    await expect(
      h.ownerPool.query("UPDATE accounts SET frozen_by = 'ops' WHERE id = $1", [a.view.id]),
    ).rejects.toThrow(/accounts_frozen_by_matches_status/);
  });
});
