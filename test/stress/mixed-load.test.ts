// Stress: 50 requests at once on one account, mixing purchases, captures,
// duplicate captures, reversals, refunds and repayments. The order in which
// Postgres serialises them is not under our control, so every assertion is
// one that must hold for EVERY order.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { signWebhook, transferReceived } from "../../src/fakes/fake-bank.js";
import { reconcile } from "../../src/jobs/reconcile.js";
import { createHarness, listen, testConfig } from "../support/harness.js";
import { activeAccount, authorization, authorize } from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const h = createHarness();
afterAll(() => h.close());
const app = h.app();

const LIMIT = 50_000;
const PRE_HOLD = 2_000;
const PURCHASE = 3_000;
const REFUND = 1_000;
const REPAYMENT = 1_500;
const ROUNDS = 3;

interface Sent {
  kind: string;
  status: number;
  body: Record<string, unknown>;
}

async function round(server: { url: string }) {
  const a = await activeAccount(app, h, LIMIT);

  // 10 holds of 2,000 approved before the storm: 1-5 get captured, 6-10 reversed.
  const pre: string[] = [];
  for (let i = 0; i < 10; i++) {
    const body = authorization({ cardToken: a.cardToken, amount: PRE_HOLD });
    expect((await authorize(app, body)).body.approved).toBe(true);
    pre.push(body.networkAuthId);
  }

  const net = { "content-type": "application/json", "x-network-key": testConfig.networkApiKey };
  const call = (kind: string, path: string, headers: Record<string, string>, body?: string) =>
    fetch(`${server.url}${path}`, { method: "POST", headers, ...(body ? { body } : {}) }).then(
      async (r): Promise<Sent> => ({
        kind,
        status: r.status,
        body: (await r.json()) as Record<string, unknown>,
      }),
    );

  const captures = pre.slice(0, 5).map((networkAuthId) =>
    JSON.stringify({
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId,
      cardToken: a.cardToken,
      amount: PRE_HOLD,
      currency: "MXN",
    }),
  );

  const requests: Promise<Sent>[] = [
    ...Array.from({ length: 20 }, () =>
      call(
        "purchase",
        "/v1/network/authorizations",
        net,
        JSON.stringify(authorization({ cardToken: a.cardToken, amount: PURCHASE })),
      ),
    ),
    ...captures.map((c) => call("capture", "/v1/network/captures", net, c)),
    ...captures.map((c) => call("capture-duplicate", "/v1/network/captures", net, c)),
    ...pre.slice(5).map((id) => call("reversal", `/v1/network/authorizations/${id}/reversal`, net)),
    ...Array.from({ length: 5 }, () =>
      call(
        "refund",
        "/v1/network/refunds",
        net,
        JSON.stringify({
          networkRefundId: `ref_${randomUUID()}`,
          cardToken: a.cardToken,
          amount: REFUND,
          currency: "MXN",
        }),
      ),
    ),
    ...Array.from({ length: 10 }, () => {
      const { payload, headers } = signWebhook(
        transferReceived({ reference: a.view.repaymentReference, amount: REPAYMENT }),
        testConfig.bankWebhookSecret,
        h.clock,
      );
      return call("repayment", "/v1/bank/webhooks", headers, payload);
    }),
  ];
  expect(requests).toHaveLength(50);
  const sent = await Promise.all(requests);

  // 1. Every request succeeded: no 5xx, no lock timeout, no deadlock.
  expect(sent.filter((s) => s.status !== 200)).toEqual([]);

  const approved = sent.filter((s) => s.kind === "purchase" && s.body.approved === true).length;
  const { rows } = await h.pool.query<{
    credit_limit: number;
    posted_debt: number;
    held_total: number;
    credit_balance: number;
    version: number;
    open_holds: number;
    captures: number;
  }>(
    `SELECT a.credit_limit, a.posted_debt, a.held_total, a.credit_balance, a.version,
            (SELECT count(*)::int FROM holds WHERE account_id = a.id AND status = 'open') AS open_holds,
            (SELECT count(*)::int FROM captures WHERE account_id = a.id) AS captures
     FROM accounts a WHERE a.id = $1`,
    [a.view.id],
  );
  const acc = rows[0]!;

  // 4. The end state is the same for every interleaving.
  //    captures 10,000 - refunds 5,000 - repayments 15,000 = 10,000 of credit,
  //    and netting never leaves debt and credit both above zero.
  const netOwed = 5 * PRE_HOLD - 5 * REFUND - 10 * REPAYMENT; // -10,000: Acme owes the customer
  expect(acc.posted_debt).toBe(0);
  expect(acc.credit_balance).toBe(-netOwed);
  expect(acc.held_total).toBe(approved * PURCHASE);
  expect(acc.open_holds).toBe(approved);
  expect(acc.captures).toBe(5); // the 5 duplicates posted nothing
  expect(approved).toBeGreaterThan(0);
  expect(approved * PURCHASE).toBeLessThanOrEqual(LIMIT);

  // 2. Never over the limit, at any moment: every recorded account state.
  //    (No capture here exceeds its hold, so this must hold after every change.)
  const states = await h.pool.query<{
    after: { postedDebt: number; heldTotal: number; creditLimit: number };
  }>(
    `SELECT after FROM audit_log
     WHERE entity_type = 'account' AND entity_id = $1 AND action <> 'account.opened'
     ORDER BY id`,
    [a.view.id],
  );
  const over = states.rows.filter(
    (r) => r.after.postedDebt + r.after.heldTotal > r.after.creditLimit,
  );
  expect(over).toEqual([]);

  // 3. No lost update: one audit row per account version.
  expect(states.rows.length).toBe(acc.version);

  // 5. The books close.
  await expectAccountConsistent(h, a.view.id);
  expect(await reconcile(h.deps, { accountIds: [a.view.id] })).toMatchObject({
    ok: true,
    mismatches: [],
  });

  return { approved, versions: acc.version };
}

describe("SPEND-17 / stress: 50 mixed requests at once on one account", () => {
  it(`holds every invariant over ${ROUNDS} rounds`, async () => {
    const server = await listen(app);
    try {
      const results = [];
      for (let i = 0; i < ROUNDS; i++) results.push(await round(server));
      // Different rounds may approve a different number of purchases: the
      // order is up to the database. Every invariant above held each time.
      expect(results).toHaveLength(ROUNDS);
    } finally {
      await server.close();
    }
    expect(await h.deps.ledger.trialBalance(h.pool)).toBe(0);
  }, 120_000);
});
