// docs/money-flow.md is executable: this test replays its account step by step
// and compares the real ledger, balances and totals with the tables in the
// document. A change to the code or to the page alone turns it red.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { payoutResult, signWebhook } from "../../src/fakes/fake-bank.js";
import { progressClosures } from "../../src/jobs/progress-closures.js";
import type { AccountView } from "../../src/modules/accounts/accounts.js";
import { createHarness, testConfig } from "../support/harness.js";
import {
  authorization,
  authorize,
  bankTransfer,
  bearer,
  getAccount,
  openAccount,
} from "../support/actors.js";
import { expectAccountConsistent } from "../support/invariants.js";

const DOC = readFileSync(new URL("../../docs/money-flow.md", import.meta.url), "utf8");

// --- reading the document ----------------------------------------------------

/** "1,150.00" or "-1,500.00" -> centavos, without floating point (MONEY-03). */
function centavos(text: string): number {
  const m = /^(-?)([\d,]+)\.(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not an MXN amount: "${text}"`);
  const value = Number(m[2]!.replaceAll(",", "")) * 100 + Number(m[3]);
  return m[1] ? -value : value;
}

/** The table rows (without header and separator) after a `<!-- check: … -->` marker. */
function tableAfter(marker: string): string[][] {
  const start = DOC.indexOf(`<!-- check: ${marker} -->`);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const rest = DOC.slice(start).split("\n").slice(1);
  if (rest[0]?.trim() === "No journal entry.") return [];
  const rows: string[][] = [];
  for (const line of rest) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows.slice(2);
}

/** A step's journal lines as sorted "kind|account|signed amount" keys. */
function docLedger(step: number): string[] {
  return tableAfter(`ledger step=${step}`)
    .map(([kind, account, debit, credit]) => {
      const amount = debit ? centavos(debit) : -centavos(credit!);
      return `${kind}|${account}|${amount}`;
    })
    .sort();
}

// --- the account -------------------------------------------------------------

const h = createHarness();
afterAll(() => h.close());
const app = h.app();
const network = (path: string, body: object) =>
  request(app).post(`/v1/network${path}`).set("X-Network-Key", testConfig.networkApiKey).send(body);

const seen = new Set<string>();

/** The journal lines this account wrote since the previous call. */
async function newLedgerLines(accountId: string): Promise<string[]> {
  const { rows } = await h.pool.query<{ id: string; kind: string; code: string; amount: number }>(
    `SELECT je.id, je.kind, la.code, jl.amount FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_id = je.id
     JOIN ledger_accounts la ON la.id = jl.ledger_account_id
     WHERE je.account_id = $1`,
    [accountId],
  );
  const fresh = rows.filter((r) => !seen.has(r.id));
  for (const r of fresh) seen.add(r.id);
  return fresh.map((r) => `${r.kind}|${r.code}|${r.amount}`).sort();
}

describe("docs/money-flow.md", () => {
  it("the document's account replays exactly on the real service", async () => {
    const customer = await bearer("customer", h.clock);
    const balances: string[][] = [];
    let view!: AccountView;
    let cardToken = "";

    const record = async (step: number) => {
      view = (await getAccount(app, await bearer("ops", h.clock), view.id)).body as AccountView;
      expect(await newLedgerLines(view.id), `ledger of step ${step}`).toEqual(docLedger(step));
      balances.push([
        String(step),
        view.status,
        String(view.creditLimit),
        String(view.heldTotal),
        String(view.postedDebt),
        String(view.creditBalance),
        String(view.availableCredit),
      ]);
      await expectAccountConsistent(h, view.id);
    };

    // Step 0: open.
    view = await openAccount(app, customer);
    await record(0);

    // Step 1: 5,000.00 collateral.
    await bankTransfer(app, h.clock, { reference: view.collateralReference, amount: 500_000 });
    const { rows } = await h.pool.query<{ token: string }>(
      "SELECT token FROM cards WHERE account_id = $1",
      [view.id],
    );
    cardToken = rows[0]!.token;
    await record(1);

    // Step 2: authorize 1,200.00.
    const auth = authorization({ cardToken, amount: 120_000 });
    expect((await authorize(app, auth)).body.approved).toBe(true);
    await record(2);

    // Step 3: capture 1,150.00 against that hold.
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId: auth.networkAuthId,
      cardToken,
      amount: 115_000,
      currency: "MXN",
    });
    await record(3);

    // Step 4: refund 150.00.
    await network("/refunds", {
      networkRefundId: `ref_${randomUUID()}`,
      cardToken,
      amount: 15_000,
      currency: "MXN",
    });
    await record(4);

    // Step 5: repayment 1,300.00.
    await bankTransfer(app, h.clock, { reference: view.repaymentReference, amount: 130_000 });
    await record(5);

    // Step 6: authorize + capture 450.00; the credit nets.
    const auth2 = authorization({ cardToken, amount: 45_000 });
    expect((await authorize(app, auth2)).body.approved).toBe(true);
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      networkAuthId: auth2.networkAuthId,
      cardToken,
      amount: 45_000,
      currency: "MXN",
    });
    await record(6);

    // Step 7: close.
    await request(app)
      .post(`/v1/accounts/${view.id}/close`)
      .set("Authorization", customer)
      .set("Idempotency-Key", randomUUID())
      .send({});
    await record(7);

    // Step 8: late capture 50.00 (no authorization).
    await network("/captures", {
      networkCaptureId: `cap_${randomUUID()}`,
      cardToken,
      amount: 5_000,
      currency: "MXN",
    });
    await record(8);

    // Step 9: 30 days later, settle.
    h.clock.advanceMs(testConfig.closingCaptureWindowDays * 24 * 60 * 60 * 1000);
    await progressClosures(h.deps, { accountIds: [view.id] });
    await record(9);

    // Step 10: the bank confirms the collateral payout.
    const payouts = await h.pool.query<{ id: string; amount: number }>(
      "SELECT id, amount FROM payouts WHERE account_id = $1 AND status = 'requested'",
      [view.id],
    );
    expect(payouts.rows.map((p) => p.amount)).toEqual([480_000]);
    const { payload, headers } = signWebhook(
      payoutResult({ payoutId: payouts.rows[0]!.id, result: "completed" }),
      testConfig.bankWebhookSecret,
      h.clock,
    );
    await request(app).post("/v1/bank/webhooks").set(headers).send(payload);
    await record(10);

    // Step 11: closed.
    await progressClosures(h.deps, { accountIds: [view.id] });
    await record(11);

    // The balances table, cell by cell.
    const docBalances = tableAfter("balances").map(([step, status, ...amounts]) => [
      step!,
      status!,
      ...amounts.map((a) => String(centavos(a))),
    ]);
    expect(balances).toEqual(docBalances);

    // The totals table: every line this account wrote, summed per ledger account.
    const totals = await h.pool.query<{ code: string; total: number }>(
      `SELECT la.code, sum(jl.amount) AS total FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
       WHERE je.account_id = $1 GROUP BY la.code`,
      [view.id],
    );
    const actual = Object.fromEntries(totals.rows.map((r) => [r.code, r.total]));
    for (const [code, amount] of tableAfter("totals")) {
      expect(actual[code!] ?? 0, `total of ${code}`).toBe(centavos(amount!));
    }
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("every step marker in the document is checked", () => {
    const markers = [...DOC.matchAll(/<!-- check: ledger step=(\d+) -->/g)].map((m) =>
      Number(m[1]),
    );
    expect(markers).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
