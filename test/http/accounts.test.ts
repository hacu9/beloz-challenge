import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness } from "../support/harness.js";
import { bearer, getAccount, openAccount, openBody } from "../support/actors.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();

describe("open account", () => {
  it("COL-01: creates a pending_collateral account with an inactive card and two references", async () => {
    const auth = await bearer("customer", h.clock);
    const view = await openAccount(app, auth);
    expect(view).toMatchObject({
      status: "pending_collateral",
      currency: "MXN",
      creditLimit: 0,
      availableCredit: 0,
      postedDebt: 0,
      heldTotal: 0,
      creditBalance: 0,
      card: { status: "inactive", last4: expect.stringMatching(/^\d{4}$/) },
    });
    expect(view.collateralReference).toMatch(/^\d{18}$/);
    expect(view.repaymentReference).toMatch(/^\d{18}$/);
    expect(view.repaymentReference).not.toBe(view.collateralReference);

    const ledgerAccounts = await h.pool.query<{ code: string }>(
      "SELECT code FROM ledger_accounts WHERE account_id = $1 ORDER BY code",
      [view.id],
    );
    expect(ledgerAccounts.rows.map((r) => r.code)).toEqual([
      "customer_collateral",
      "customer_credit",
      "customer_receivable",
    ]);
    const audit = await h.pool.query("SELECT action FROM audit_log WHERE entity_id = $1", [
      view.id,
    ]);
    expect(audit.rows).toEqual([{ action: "account.opened" }]);
  });

  it("SEC-05: stores and returns only a token and the last 4 digits", async () => {
    const view = await openAccount(app, await bearer("customer", h.clock));
    expect(Object.keys(view.card).sort()).toEqual(["last4", "status"]);
    const { rows } = await h.pool.query("SELECT * FROM cards WHERE account_id = $1", [view.id]);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ["account_id", "created_at", "id", "last4", "status", "token", "updated_at"].sort(),
    );
    expect((rows[0] as { token: string }).token).toMatch(/^tok_[0-9a-f]{32}$/);
  });

  it("COL-10: a customer cannot open a second open account (409)", async () => {
    const auth = await bearer("customer", h.clock);
    await openAccount(app, auth);
    const res = await request(app)
      .post("/v1/accounts")
      .set("Authorization", auth)
      .set("Idempotency-Key", randomUUID())
      .send(openBody);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_exists");
  });

  it("COL-10: two parallel opens with different keys create one account", async () => {
    const auth = await bearer("customer", h.clock);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        request(app)
          .post("/v1/accounts")
          .set("Authorization", auth)
          .set("Idempotency-Key", randomUUID())
          .send(openBody),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("IDEM-03: retrying the open with the same key returns the same account", async () => {
    const auth = await bearer("customer", h.clock);
    const key = randomUUID();
    const send = () =>
      request(app)
        .post("/v1/accounts")
        .set("Authorization", auth)
        .set("Idempotency-Key", key)
        .send(openBody);
    const first = await send();
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it("SEC-01: ops cannot open an account for itself", async () => {
    const res = await request(app)
      .post("/v1/accounts")
      .set("Authorization", await bearer("ops", h.clock))
      .set("Idempotency-Key", randomUUID())
      .send(openBody);
    expect(res.status).toBe(403);
  });
});

describe("D-M6-3: payout CLABE", () => {
  it("opening an account requires an 18-digit payout CLABE; the view shows only its last 4", async () => {
    const auth = await bearer("customer", h.clock);
    for (const body of [{}, { payoutClabe: "123" }, { payoutClabe: "01218000123456789x" }]) {
      const res = await request(app)
        .post("/v1/accounts")
        .set("Authorization", auth)
        .set("Idempotency-Key", randomUUID())
        .send(body);
      expect(res.status).toBe(422);
    }
    const view = await openAccount(app, auth);
    expect(view.payoutClabeLast4).toBe("7897");
    expect(JSON.stringify(view)).not.toContain("012180001234567897");
  });
});

describe("SEC-02: ownership", () => {
  it("the owner and ops can read the account; another customer gets 404", async () => {
    const owner = await bearer("customer", h.clock);
    const view = await openAccount(app, owner);
    expect((await getAccount(app, owner, view.id)).status).toBe(200);
    expect((await getAccount(app, await bearer("ops", h.clock), view.id)).status).toBe(200);

    const stranger = await getAccount(app, await bearer("customer", h.clock), view.id);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe("not_found");
  });

  it("a malformed ID and an unknown ID look the same as a foreign one", async () => {
    const auth = await bearer("customer", h.clock);
    expect((await getAccount(app, auth, "not-a-uuid")).status).toBe(404);
    expect((await getAccount(app, auth, randomUUID())).status).toBe(404);
  });

  it("the account list holds only the caller's accounts", async () => {
    const auth = await bearer("customer", h.clock);
    const mine = await openAccount(app, auth);
    await openAccount(app, await bearer("customer", h.clock));
    const res = await request(app).get("/v1/accounts").set("Authorization", auth);
    expect((res.body as { accounts: AccountView[] }).accounts.map((a) => a.id)).toEqual([mine.id]);
  });
});
