import { z } from "zod";
import type pg from "pg";
import type { Clock } from "../../platform/clock.js";
import type { Queryable } from "../../platform/db/pool.js";
import { withTx, type Tx } from "../../platform/db/tx.js";
import { conflict, notFound, unprocessable } from "../../platform/errors.js";
import type { Centavos } from "../../platform/money.js";
import type { Account, Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import { transfer, type Ledger } from "../ledger/ledger.js";
import type { BankClient } from "./bank-client.js";

export type PayoutKind = "collateral" | "credit" | "return";
export type PayoutStatus = "requested" | "completed" | "failed" | "unknown" | "cancelled";

export interface Payout {
  id: string;
  account_id: string;
  kind: PayoutKind;
  amount: Centavos;
  status: PayoutStatus;
  source_cash: "cash_collateral" | "cash_operating";
  destination_clabe: string;
  return_of: string | null;
  submitted_at: Date | null;
  /** OQ-13: set when ops releases a cancelled (parked) payout. */
  released_at: Date | null;
  journal_id: string | null;
  bank_txn_id: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  mismatch: boolean;
  created_at: Date;
  updated_at: Date;
}

// PAYOUT-05, OQ-13: a payout holds its money while it is requested, unknown
// or failed, and while it is cancelled but not released ("parked"). Held
// money never nets, is never paid out again, and keeps the account open.
const HELD = `(status IN ('requested', 'unknown', 'failed')
               OR (status = 'cancelled' AND released_at IS NULL))`;

export const PayoutResultEvent = z.object({
  type: z.enum(["payout.completed", "payout.failed"]),
  bankTxnId: z.string().min(1).max(128),
  payoutId: z.string().uuid(),
});
export type PayoutResultEvent = z.infer<typeof PayoutResultEvent>;

export const ResolveRequest = z.object({
  action: z.enum(["completed", "failed", "retry", "cancel"]),
  note: z.string().min(1).max(1000),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const ReleaseRequest = z.object({
  note: z.string().min(1).max(1000),
  /** Optional new payout CLABE; a bad CLABE is the usual reason for a cancel. */
  payoutClabe: z
    .string()
    .regex(/^\d{18}$/)
    .optional(),
});
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;

export type PayoutResultOutcome =
  "payout_result_applied" | "payout_result_ignored" | "payout_result_mismatch";

const SYSTEM: Actor = { type: "system" };
const BANK: Actor = { type: "bank" };

export type StuckReason = "not_submitted" | "no_bank_result";

export function toPayoutView(p: Payout & { stuck_reason?: StuckReason | null }) {
  return {
    id: p.id,
    accountId: p.account_id,
    kind: p.kind,
    amount: p.amount,
    currency: "MXN" as const,
    status: p.status,
    sourceCash: p.source_cash,
    destinationClabeLast4: p.destination_clabe.slice(-4),
    returnOf: p.return_of,
    submittedAt: p.submitted_at?.toISOString() ?? null,
    parked: p.status === "cancelled" && p.released_at === null,
    releasedAt: p.released_at?.toISOString() ?? null,
    resolvedBy: p.resolved_by,
    resolutionNote: p.resolution_note,
    mismatch: p.mismatch,
    stuckReason: p.stuck_reason ?? null,
    createdAt: p.created_at.toISOString(),
  };
}

// Money going out. Every change to a payout happens under its account's row
// lock, so payout creation, netting and results never race each other.
export class Payouts {
  constructor(
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
    private readonly accounts: Accounts,
    private readonly bank: BankClient,
  ) {}

  /** Operating-sourced credit held by a credit payout. */
  private async reservedCredit(tx: Tx, accountId: string): Promise<Centavos> {
    const { rows } = await tx.query<{ reserved: number }>(
      `SELECT coalesce(sum(amount), 0) AS reserved FROM payouts
       WHERE account_id = $1 AND kind = 'credit' AND ${HELD}`,
      [accountId],
    );
    return rows[0]!.reserved;
  }

  /** Collateral held by a collateral payout (CLOSE-04). */
  async reservedCollateral(tx: Tx, accountId: string): Promise<Centavos> {
    const { rows } = await tx.query<{ reserved: number }>(
      `SELECT coalesce(sum(amount), 0) AS reserved FROM payouts
       WHERE account_id = $1 AND kind = 'collateral' AND ${HELD}`,
      [accountId],
    );
    return rows[0]!.reserved;
  }

  /** CLOSE-04: pays the remaining collateral back. Call under the account lock. */
  async createCollateralPayout(tx: Tx, account: Account, amount: Centavos): Promise<Payout> {
    if (!account.payout_clabe) throw new Error(`account ${account.id} has no payout CLABE`);
    return this.insert(tx, account, "collateral", amount, "cash_collateral", null);
  }

  /** Any payout of this account that still holds money (PAYOUT-07, OQ-13). */
  async hasOpenPayouts(tx: Tx, accountId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM payouts WHERE account_id = $1 AND ${HELD} LIMIT 1`,
      [accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  // A1: when the account owes money (open or charged-off), a collateral
  // payout that certainly did not leave (failed) is cancelled and released at
  // once, so settlement can use that collateral. A requested or unknown one
  // may have left and is not touched. Call under the account lock.
  async releaseFailedCollateral(tx: Tx, account: Account): Promise<number> {
    const { rows } = await tx.query<Payout>(
      `UPDATE payouts SET status = 'cancelled', released_at = $2, updated_at = $2,
         resolution_note = 'collateral needed for debt (A1)'
       WHERE account_id = $1 AND kind = 'collateral' AND status = 'failed'
       RETURNING *`,
      [account.id, this.clock.now()],
    );
    for (const p of rows) {
      await this.audit.write(tx, {
        actor: SYSTEM,
        action: "payout.cancelled_for_debt",
        entityType: "payout",
        entityId: p.id,
        before: { status: "failed" },
        after: { status: "cancelled", released: true, amount: p.amount },
      });
    }
    return rows.length;
  }

  /** Credit that is neither returnable nor in a payout: the only credit that may net. */
  async freeCredit(tx: Tx, account: Account): Promise<Centavos> {
    return (
      account.credit_balance -
      account.credit_returnable -
      (await this.reservedCredit(tx, account.id))
    );
  }

  // PAYOUT-10: free credit pays new debt, as long as no payout took it yet.
  // Call under the account lock, after the debt was posted.
  async netAgainstDebt(tx: Tx, account: Account, actor: Actor): Promise<Account> {
    const amount = Math.min(await this.freeCredit(tx, account), account.posted_debt);
    if (amount <= 0) return account;
    const own = await this.ledger.customerAccounts(tx, account.id);
    await this.ledger.post(tx, {
      kind: "credit_netting",
      accountId: account.id,
      lines: transfer(own.customer_credit, own.customer_receivable, amount),
    });
    return this.accounts.update(
      tx,
      account,
      {
        posted_debt: account.posted_debt - amount,
        credit_balance: account.credit_balance - amount,
      },
      { actor, action: "credit.netted" },
    );
  }

  // REPAY-04, PAYOUT-11: creates the payouts an account is due, and reserves
  // their money. Returns of credited deposits leave from cash_collateral; free
  // credit leaves from cash_operating. Sending happens after commit (submit).
  async createDue(tx: Tx, accountId: string): Promise<Payout[]> {
    const locked = await this.accounts.lock(tx, accountId);
    if (!locked?.payout_clabe) return [];
    // A2: free credit pays existing debt before any of it is paid out.
    const account = await this.netAgainstDebt(tx, locked, SYSTEM);
    const created: Payout[] = [];

    // A return gives back what of the deposit was not used to recover
    // charged-off debt (B3). A released return no longer blocks a new one.
    const { rows: deposits } = await tx.query<{ bank_txn_id: string; amount: number }>(
      `SELECT bt.bank_txn_id,
              bt.amount - coalesce((SELECT sum(c.amount) FROM charge_offs c
                                    WHERE c.journal_id = bt.journal_id AND c.kind = 'recovery'), 0)
                AS amount
       FROM bank_transactions bt
       WHERE bt.account_id = $1
         AND bt.outcome IN ('credited_below_minimum', 'credited_for_payback')
         AND NOT EXISTS (SELECT 1 FROM payouts p
                         WHERE p.return_of = bt.bank_txn_id AND p.released_at IS NULL)
       ORDER BY bt.received_at`,
      [accountId],
    );
    for (const d of deposits.filter((d) => d.amount > 0)) {
      created.push(
        await this.insert(tx, account, "return", d.amount, "cash_collateral", d.bank_txn_id),
      );
    }

    const free = await this.freeCredit(tx, account);
    if (free > 0)
      created.push(await this.insert(tx, account, "credit", free, "cash_operating", null));
    return created;
  }

  private async insert(
    tx: Tx,
    account: Account,
    kind: PayoutKind,
    amount: Centavos,
    source: Payout["source_cash"],
    returnOf: string | null,
  ): Promise<Payout> {
    const now = this.clock.now();
    const { rows } = await tx.query<Payout>(
      `INSERT INTO payouts (account_id, kind, amount, status, source_cash, destination_clabe, return_of, created_at, updated_at)
       VALUES ($1, $2, $3, 'requested', $4, $5, $6, $7, $7) RETURNING *`,
      [account.id, kind, amount, source, account.payout_clabe, returnOf, now],
    );
    const payout = rows[0]!;
    await this.audit.write(tx, {
      actor: SYSTEM,
      action: "payout.requested",
      entityType: "payout",
      entityId: payout.id,
      before: null,
      after: { kind, amount, source, returnOf },
    });
    return payout;
  }

  // Sends one requested payout to the bank. Runs outside any transaction: no
  // lock is held during the network call. PAYOUT-02: anything but a clear
  // answer is "unknown". PAYOUT-03: never called again on its own for the
  // same payout; only a person's "retry" puts it back to requested.
  async submit(pool: pg.Pool, payoutId: string): Promise<PayoutStatus> {
    // B1: claim the payout before the bank call. Of two concurrent callers,
    // exactly one gets the row back; the other sends nothing. A crash after
    // the claim leaves it submitted with no result: the ops list flags it
    // (no_bank_result) and a person checks with the bank.
    const claim = await withTx(pool, async (tx) => {
      const { rows } = await tx.query<Payout>("SELECT * FROM payouts WHERE id = $1", [payoutId]);
      if (!rows[0]) throw notFound("payout not found");
      await this.accounts.lock(tx, rows[0].account_id);
      const claimed = await tx.query<Payout>(
        `UPDATE payouts SET submitted_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'requested' AND submitted_at IS NULL RETURNING *`,
        [payoutId, this.clock.now()],
      );
      return { payout: claimed.rows[0], status: rows[0].status };
    });
    if (!claim.payout) return claim.status;
    const payout = claim.payout;

    let answer: "accepted" | "rejected" | "unknown";
    try {
      answer = await this.bank.requestPayout({
        payoutId: payout.id,
        amount: payout.amount,
        sourceAccount: payout.source_cash,
        destinationClabe: payout.destination_clabe,
      });
    } catch {
      // BankUnknownOutcomeError, a reset connection, a 5xx: whatever the
      // error, we cannot tell whether the bank paid, so it is unknown.
      answer = "unknown";
    }

    return withTx(pool, async (tx) => {
      await this.accounts.lock(tx, payout.account_id);
      const current = await this.lockPayout(tx, payout.id);
      // A webhook may have resolved it while we waited for the bank.
      if (current.status !== "requested") return current.status;
      const status: PayoutStatus =
        answer === "accepted" ? "requested" : answer === "rejected" ? "failed" : "unknown";
      await tx.query(`UPDATE payouts SET status = $2, updated_at = $3 WHERE id = $1`, [
        payout.id,
        status,
        this.clock.now(),
      ]);
      await this.audit.write(tx, {
        actor: BANK,
        action: `payout.submission_${answer}`,
        entityType: "payout",
        entityId: payout.id,
        before: { status: "requested" },
        after: { status },
      });
      return status;
    });
  }

  // PAYOUT-08, PAYOUT-09. Lock order: bank transaction ID, account, payout.
  async receiveResult(
    tx: Tx,
    event: PayoutResultEvent,
  ): Promise<{
    bankTxnId: string;
    payoutId: string;
    outcome: PayoutResultOutcome;
    duplicate: boolean;
  }> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `bank_txn:${event.bankTxnId}`,
    ]);
    const { rows: seen } = await tx.query<{ outcome: PayoutResultOutcome; reference: string }>(
      "SELECT outcome, reference FROM bank_transactions WHERE bank_txn_id = $1",
      [event.bankTxnId],
    );
    if (seen[0]) {
      if (seen[0].reference !== event.payoutId) {
        throw conflict("bank_txn_conflict", "this bank transaction ID was already used");
      }
      return {
        bankTxnId: event.bankTxnId,
        payoutId: event.payoutId,
        outcome: seen[0].outcome,
        duplicate: true,
      };
    }

    const { rows } = await tx.query<{ account_id: string }>(
      "SELECT account_id FROM payouts WHERE id = $1",
      [event.payoutId],
    );
    if (!rows[0]) throw unprocessable("payout_not_found", "no payout with this ID");
    const account = (await this.accounts.lock(tx, rows[0].account_id))!;
    const payout = await this.lockPayout(tx, event.payoutId);
    const result = event.type === "payout.completed" ? "completed" : "failed";

    let outcome: PayoutResultOutcome;
    if (payout.status === "requested" || payout.status === "unknown") {
      if (result === "completed") await this.complete(tx, account, payout, BANK, event.bankTxnId);
      else await this.setStatus(tx, payout, "failed", BANK, {});
      outcome = "payout_result_applied";
    } else if (this.agrees(payout.status, result)) {
      outcome = "payout_result_ignored";
    } else {
      // A person (or an earlier bank answer) recorded something else. Change
      // nothing; a person must look at it.
      await tx.query("UPDATE payouts SET mismatch = true, updated_at = $2 WHERE id = $1", [
        payout.id,
        this.clock.now(),
      ]);
      await this.audit.write(tx, {
        actor: BANK,
        action: "payout.mismatch",
        entityType: "payout",
        entityId: payout.id,
        before: { status: payout.status, resolvedBy: payout.resolved_by },
        after: { bankResult: result, bankTxnId: event.bankTxnId },
      });
      outcome = "payout_result_mismatch";
    }

    await tx.query(
      `INSERT INTO bank_transactions (bank_txn_id, kind, reference, account_id, outcome, received_at)
       VALUES ($1, 'payout_result', $2, $3, $4, $5)`,
      [event.bankTxnId, event.payoutId, account.id, outcome, this.clock.now()],
    );
    return { bankTxnId: event.bankTxnId, payoutId: event.payoutId, outcome, duplicate: false };
  }

  /** A "failed" bank result agrees with failed and cancelled; "completed" only with completed. */
  private agrees(status: PayoutStatus, result: "completed" | "failed"): boolean {
    return result === "completed"
      ? status === "completed"
      : status === "failed" || status === "cancelled";
  }

  // PAYOUT-04: only ops resolves. completed/failed close a requested or
  // unknown payout; retry/cancel act on a failed one.
  async resolve(
    tx: Tx,
    payoutId: string,
    req: ResolveRequest,
    ops: Actor,
  ): Promise<{ payout: Payout; needsSubmit: boolean }> {
    const { rows } = await tx.query<{ account_id: string }>(
      "SELECT account_id FROM payouts WHERE id = $1",
      [payoutId],
    );
    if (!rows[0]) throw notFound("payout not found");
    const account = (await this.accounts.lock(tx, rows[0].account_id))!;
    const payout = await this.lockPayout(tx, payoutId);

    const allowed: Record<ResolveRequest["action"], readonly PayoutStatus[]> = {
      completed: ["requested", "unknown"],
      failed: ["requested", "unknown"],
      retry: ["failed"],
      cancel: ["failed"],
    };
    if (!allowed[req.action].includes(payout.status)) {
      throw conflict("payout_state", `cannot ${req.action} a ${payout.status} payout`);
    }
    const resolution = { resolved_by: ops.id ?? null, resolution_note: req.note };

    if (req.action === "completed") {
      await this.complete(tx, account, payout, ops, null, resolution);
    } else if (req.action === "failed") {
      await this.setStatus(tx, payout, "failed", ops, resolution);
    } else if (req.action === "cancel") {
      // OQ-13: cancel parks the money. It stays held (no netting, no new
      // payout, no closure) until ops releases it.
      await this.setStatus(tx, payout, "cancelled", ops, resolution);
    } else {
      // Retry: back to requested, not yet submitted. Same payout ID, so the
      // bank can still dedupe it (PAYOUT-06).
      await tx.query(
        `UPDATE payouts SET status = 'requested', submitted_at = NULL, resolved_by = $2,
           resolution_note = $3, updated_at = $4 WHERE id = $1`,
        [payout.id, resolution.resolved_by, resolution.resolution_note, this.clock.now()],
      );
      await this.audit.write(tx, {
        actor: ops,
        action: "payout.retry",
        entityType: "payout",
        entityId: payout.id,
        before: { status: payout.status },
        after: { status: "requested", note: req.note },
      });
    }
    return { payout: await this.lockPayout(tx, payout.id), needsSubmit: req.action === "retry" };
  }

  // OQ-13: ends the parking of a cancelled payout. Released credit first pays
  // debt (A2), and the jobs then pay out what is left; a released return or
  // collateral payout is created again by the next job run.
  async release(tx: Tx, payoutId: string, req: ReleaseRequest, ops: Actor): Promise<Payout> {
    const { rows } = await tx.query<{ account_id: string }>(
      "SELECT account_id FROM payouts WHERE id = $1",
      [payoutId],
    );
    if (!rows[0]) throw notFound("payout not found");
    let account = (await this.accounts.lock(tx, rows[0].account_id))!;
    const payout = await this.lockPayout(tx, payoutId);
    if (payout.status !== "cancelled" || payout.released_at) {
      throw conflict(
        "payout_state",
        "only a parked (cancelled, not released) payout can be released",
      );
    }
    if (req.payoutClabe && req.payoutClabe !== account.payout_clabe) {
      account = await this.accounts.update(
        tx,
        account,
        { payout_clabe: req.payoutClabe },
        { actor: ops, action: "account.payout_clabe_changed" },
      );
    }
    await tx.query(
      `UPDATE payouts SET released_at = $2, resolved_by = $3, resolution_note = $4, updated_at = $2
       WHERE id = $1`,
      [payout.id, this.clock.now(), ops.id ?? null, req.note],
    );
    await this.audit.write(tx, {
      actor: ops,
      action: "payout.released",
      entityType: "payout",
      entityId: payout.id,
      before: { status: "cancelled", parked: true },
      after: { status: "cancelled", parked: false, note: req.note, newClabe: !!req.payoutClabe },
    });
    if (payout.kind === "credit") await this.netAgainstDebt(tx, account, ops);
    return this.lockPayout(tx, payout.id);
  }

  // PAYOUT-05: the ledger moves only when the money really left.
  private async complete(
    tx: Tx,
    account: Account,
    payout: Payout,
    actor: Actor,
    bankTxnId: string | null,
    resolution: { resolved_by?: string | null; resolution_note?: string } = {},
  ): Promise<void> {
    const own = await this.ledger.customerAccounts(tx, account.id);
    const collateral = payout.kind === "collateral";
    const { journalId } = await this.ledger.post(tx, {
      kind: collateral ? "collateral_payout" : "credit_payout",
      accountId: account.id,
      lines: transfer(
        collateral ? own.customer_collateral : own.customer_credit,
        await this.ledger.systemAccountId(tx, payout.source_cash),
        payout.amount,
      ),
    });
    await this.accounts.update(
      tx,
      account,
      collateral
        ? { credit_limit: account.credit_limit - payout.amount }
        : {
            credit_balance: account.credit_balance - payout.amount,
            ...(payout.kind === "return"
              ? { credit_returnable: account.credit_returnable - payout.amount }
              : {}),
          },
      { actor, action: "payout.completed" },
    );
    await tx.query(
      `UPDATE payouts SET status = 'completed', journal_id = $2, bank_txn_id = $3,
         resolved_by = coalesce($4, resolved_by), resolution_note = coalesce($5, resolution_note),
         updated_at = $6 WHERE id = $1`,
      [
        payout.id,
        journalId,
        bankTxnId,
        resolution.resolved_by ?? null,
        resolution.resolution_note ?? null,
        this.clock.now(),
      ],
    );
    await this.audit.write(tx, {
      actor,
      action: "payout.completed",
      entityType: "payout",
      entityId: payout.id,
      before: { status: payout.status },
      after: { status: "completed", journalId, bankTxnId },
    });
  }

  private async setStatus(
    tx: Tx,
    payout: Payout,
    status: PayoutStatus,
    actor: Actor,
    resolution: { resolved_by?: string | null; resolution_note?: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE payouts SET status = $2, resolved_by = coalesce($3, resolved_by),
         resolution_note = coalesce($4, resolution_note), updated_at = $5 WHERE id = $1`,
      [
        payout.id,
        status,
        resolution.resolved_by ?? null,
        resolution.resolution_note ?? null,
        this.clock.now(),
      ],
    );
    await this.audit.write(tx, {
      actor,
      action: `payout.${status}`,
      entityType: "payout",
      entityId: payout.id,
      before: { status: payout.status },
      after: { status, note: resolution.resolution_note },
    });
  }

  private async lockPayout(tx: Tx, payoutId: string): Promise<Payout> {
    const { rows } = await tx.query<Payout>("SELECT * FROM payouts WHERE id = $1 FOR UPDATE", [
      payoutId,
    ]);
    if (!rows[0]) throw notFound("payout not found");
    return rows[0];
  }

  // PAYOUT-14: a requested payout is stuck when, after `stuckBefore`, it was
  // never submitted (the process died before the bank call) or the bank took
  // it but sent no result. Nothing resends it; a person looks.
  async list(
    db: Queryable,
    filter: {
      stuckBefore: Date;
      statuses?: PayoutStatus[];
      mismatch?: boolean;
      accountId?: string;
      stuck?: boolean;
    },
  ): Promise<(Payout & { stuck_reason: StuckReason | null })[]> {
    const { rows } = await db.query<Payout & { stuck_reason: StuckReason | null }>(
      `SELECT * FROM (
         SELECT p.*,
           CASE
             WHEN p.status = 'requested' AND p.submitted_at IS NULL AND p.created_at <= $5
               THEN 'not_submitted'
             WHEN p.status = 'requested' AND p.submitted_at <= $5
               THEN 'no_bank_result'
           END AS stuck_reason
         FROM payouts p) x
       WHERE ($1::text[] IS NULL OR status = ANY($1))
         AND ($2::boolean IS NULL OR mismatch = $2)
         AND ($3::uuid IS NULL OR account_id = $3)
         AND ($4::boolean IS NULL OR (stuck_reason IS NOT NULL) = $4)
       ORDER BY created_at`,
      [
        filter.statuses ?? null,
        filter.mismatch ?? null,
        filter.accountId ?? null,
        filter.stuck ?? null,
        filter.stuckBefore,
      ],
    );
    return rows;
  }
}
