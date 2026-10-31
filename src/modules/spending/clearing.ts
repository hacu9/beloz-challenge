import { z } from "zod";
import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { conflict, notFound, unprocessable } from "../../platform/errors.js";
import { addCentavos, type Centavos } from "../../platform/money.js";
import type { Account, Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import { transfer, type JournalLineInput, type Ledger } from "../ledger/ledger.js";
import type { Authorizations } from "./authorizations.js";

const NETWORK: Actor = { type: "network" };
// Money the network already moved: no MAX_AMOUNT, it is recorded, never refused.
const NetworkAmount = z.number().int().positive().refine(Number.isSafeInteger);

export const CaptureRequest = z.object({
  networkCaptureId: z.string().min(1).max(128),
  /** OQ-08: may be absent or unknown (force post). */
  networkAuthId: z.string().min(1).max(128).optional(),
  cardToken: z.string().min(1).max(128),
  amount: NetworkAmount,
  currency: z.literal("MXN"),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const RefundRequest = z.object({
  networkRefundId: z.string().min(1).max(128),
  networkCaptureId: z.string().min(1).max(128).optional(),
  cardToken: z.string().min(1).max(128),
  amount: NetworkAmount,
  currency: z.literal("MXN"),
});
export type RefundRequest = z.infer<typeof RefundRequest>;

interface HoldRow {
  id: string;
  account_id: string;
  amount: number;
  status: "open" | "captured" | "reversed" | "expired";
}

export interface CaptureResult {
  networkCaptureId: string;
  captureId: string;
  holdId: string | null;
  amount: Centavos;
  duplicate: boolean;
}

export interface ReversalResult {
  networkAuthId: string;
  holdId: string | null;
  holdStatus: HoldRow["status"] | null;
  released: Centavos;
}

export interface RefundResult {
  networkRefundId: string;
  refundId: string;
  debtReduced: Centavos;
  credited: Centavos;
  duplicate: boolean;
}

// Clearing: what happens after an authorization. We can decline an
// authorization, never a capture or a refund: the network already moved the
// money, so these always post (SPEND-06, CLOSE-08).
export class Clearing {
  constructor(
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
    private readonly accounts: Accounts,
    private readonly authorizations: Authorizations,
  ) {}

  // SPEND-06, SPEND-07, SPEND-11. Lock order: capture ID, then account row.
  async capture(tx: Tx, req: CaptureRequest): Promise<CaptureResult> {
    await this.lockId(tx, `network_capture:${req.networkCaptureId}`);
    const { rows: seen } = await tx.query<{
      id: string;
      hold_id: string | null;
      amount: number;
      card_token: string;
      network_auth_id: string | null;
    }>(
      "SELECT id, hold_id, amount, card_token, network_auth_id FROM captures WHERE network_capture_id = $1",
      [req.networkCaptureId],
    );
    if (seen[0]) {
      const s = seen[0];
      if (
        s.amount !== req.amount ||
        s.card_token !== req.cardToken ||
        s.network_auth_id !== (req.networkAuthId ?? null)
      ) {
        throw conflict(
          "network_capture_conflict",
          "this capture ID was already used with different data",
        );
      }
      return {
        networkCaptureId: req.networkCaptureId,
        captureId: s.id,
        holdId: s.hold_id,
        amount: s.amount,
        duplicate: true,
      };
    }

    let account = await this.lockAccountForCard(tx, req.cardToken);
    account = await this.authorizations.expireHolds(tx, account);

    // The hold this capture clears, if any. Only an open hold is released and
    // linked (one capture per hold, OQ-09). An expired, reversed or already
    // captured hold changes nothing; the capture still posts and keeps the
    // network_auth_id for the record (OQ-08).
    const hold = req.networkAuthId
      ? await this.lockHold(tx, req.networkAuthId, account.id)
      : undefined;
    let heldTotal = account.held_total;
    let holdId: string | null = null;
    if (hold?.status === "open") {
      await tx.query("UPDATE holds SET status = 'captured', closed_at = $2 WHERE id = $1", [
        hold.id,
        this.clock.now(),
      ]);
      heldTotal -= hold.amount;
      holdId = hold.id;
    }

    const own = await this.ledger.customerAccounts(tx, account.id);
    const { journalId } = await this.ledger.post(tx, {
      kind: "capture",
      accountId: account.id,
      lines: transfer(
        own.customer_receivable,
        await this.ledger.systemAccountId(tx, "network_payable"),
        req.amount,
      ),
    });
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO captures (network_capture_id, account_id, hold_id, network_auth_id, card_token, amount, journal_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        req.networkCaptureId,
        account.id,
        holdId,
        req.networkAuthId ?? null,
        req.cardToken,
        req.amount,
        journalId,
        this.clock.now(),
      ],
    );
    await this.accounts.update(
      tx,
      account,
      { held_total: heldTotal, posted_debt: addCentavos(account.posted_debt, req.amount) },
      { actor: NETWORK, action: "capture.posted" },
    );
    await this.audit.write(tx, {
      actor: NETWORK,
      action: "capture.posted",
      entityType: "capture",
      entityId: rows[0]!.id,
      before: hold ? { holdStatus: hold.status, holdAmount: hold.amount } : null,
      after: { amount: req.amount, holdId, journalId, forcePost: !hold },
    });
    return {
      networkCaptureId: req.networkCaptureId,
      captureId: rows[0]!.id,
      holdId,
      amount: req.amount,
      duplicate: false,
    };
  }

  // SPEND-08: releases an open hold, writes nothing to the ledger. Repeating
  // a reversal is harmless: the hold is no longer open, so nothing changes.
  async reverse(tx: Tx, networkAuthId: string): Promise<ReversalResult> {
    const { rows } = await tx.query<{ account_id: string | null; approved: boolean }>(
      "SELECT account_id, approved FROM authorizations WHERE network_auth_id = $1",
      [networkAuthId],
    );
    const auth = rows[0];
    if (!auth) throw notFound("authorization not found");
    if (!auth.approved || !auth.account_id) {
      return { networkAuthId, holdId: null, holdStatus: null, released: 0 };
    }

    let account = await this.accounts.lock(tx, auth.account_id);
    if (!account) throw new Error(`authorization ${networkAuthId} points to a missing account`);
    account = await this.authorizations.expireHolds(tx, account);
    const hold = (await this.lockHold(tx, networkAuthId, account.id))!;
    if (hold.status === "captured") {
      throw conflict(
        "hold_already_captured",
        "the authorization was already captured; send a refund",
      );
    }
    if (hold.status !== "open") {
      return { networkAuthId, holdId: hold.id, holdStatus: hold.status, released: 0 };
    }

    await tx.query("UPDATE holds SET status = 'reversed', closed_at = $2 WHERE id = $1", [
      hold.id,
      this.clock.now(),
    ]);
    await this.accounts.update(
      tx,
      account,
      { held_total: account.held_total - hold.amount },
      { actor: NETWORK, action: "hold.reversed" },
    );
    await this.audit.write(tx, {
      actor: NETWORK,
      action: "hold.reversed",
      entityType: "hold",
      entityId: hold.id,
      before: { status: "open" },
      after: { status: "reversed", amount: hold.amount },
    });
    return { networkAuthId, holdId: hold.id, holdStatus: "reversed", released: hold.amount };
  }

  // SPEND-10: a refund reduces the debt first; any excess becomes a credit
  // balance that is paid back (M6). It never raises available credit beyond
  // the limit, because the credit balance is not part of it (SPEND-12).
  async refund(tx: Tx, req: RefundRequest): Promise<RefundResult> {
    await this.lockId(tx, `network_refund:${req.networkRefundId}`);
    const { rows: seen } = await tx.query<{
      id: string;
      amount: number;
      card_token: string;
      debt_reduced: number;
      credited: number;
    }>(
      "SELECT id, amount, card_token, debt_reduced, credited FROM refunds WHERE network_refund_id = $1",
      [req.networkRefundId],
    );
    if (seen[0]) {
      const s = seen[0];
      if (s.amount !== req.amount || s.card_token !== req.cardToken) {
        throw conflict(
          "network_refund_conflict",
          "this refund ID was already used with different data",
        );
      }
      return {
        networkRefundId: req.networkRefundId,
        refundId: s.id,
        debtReduced: s.debt_reduced,
        credited: s.credited,
        duplicate: true,
      };
    }

    const account = await this.lockAccountForCard(tx, req.cardToken);
    const debtReduced = Math.min(req.amount, account.posted_debt);
    const credited = req.amount - debtReduced;
    const own = await this.ledger.customerAccounts(tx, account.id);
    const networkPayable = await this.ledger.systemAccountId(tx, "network_payable");
    const lines: JournalLineInput[] = [{ ledgerAccountId: networkPayable, amount: req.amount }];
    if (debtReduced > 0)
      lines.push({ ledgerAccountId: own.customer_receivable, amount: -debtReduced });
    if (credited > 0) lines.push({ ledgerAccountId: own.customer_credit, amount: -credited });
    const { journalId } = await this.ledger.post(tx, {
      kind: "refund",
      accountId: account.id,
      lines,
    });

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO refunds (network_refund_id, network_capture_id, account_id, card_token, amount, debt_reduced, credited, journal_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.networkRefundId,
        req.networkCaptureId ?? null,
        account.id,
        req.cardToken,
        req.amount,
        debtReduced,
        credited,
        journalId,
        this.clock.now(),
      ],
    );
    await this.accounts.update(
      tx,
      account,
      {
        posted_debt: account.posted_debt - debtReduced,
        credit_balance: addCentavos(account.credit_balance, credited),
      },
      { actor: NETWORK, action: "refund.posted" },
    );
    await this.audit.write(tx, {
      actor: NETWORK,
      action: "refund.posted",
      entityType: "refund",
      entityId: rows[0]!.id,
      before: null,
      after: { amount: req.amount, debtReduced, credited, journalId },
    });
    return {
      networkRefundId: req.networkRefundId,
      refundId: rows[0]!.id,
      debtReduced,
      credited,
      duplicate: false,
    };
  }

  private async lockId(tx: Tx, key: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }

  // OQ-08: a capture or refund must name a known card; we cannot post money
  // to nobody. An unknown card is a malformed delivery (422) for ops to chase.
  private async lockAccountForCard(tx: Tx, cardToken: string): Promise<Account> {
    const accountId = await this.accounts.accountIdForCardToken(tx, cardToken);
    if (!accountId) throw unprocessable("card_not_found", "no card with this token");
    const account = await this.accounts.lock(tx, accountId);
    if (!account) throw new Error(`card ${cardToken} points to a missing account`);
    return account;
  }

  /** Locks the hold of an authorization on this account; call under the account lock. */
  private async lockHold(
    tx: Tx,
    networkAuthId: string,
    accountId: string,
  ): Promise<HoldRow | undefined> {
    const { rows } = await tx.query<HoldRow>(
      `SELECT id, account_id, amount, status FROM holds
       WHERE network_auth_id = $1 AND account_id = $2 FOR UPDATE`,
      [networkAuthId, accountId],
    );
    return rows[0];
  }
}
