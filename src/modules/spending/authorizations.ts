import { z } from "zod";
import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { conflict } from "../../platform/errors.js";
import { addCentavos, type Centavos } from "../../platform/money.js";
import { availableCredit, type Account, type Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const AuthorizationRequest = z.object({
  networkAuthId: z.string().min(1).max(128),
  cardToken: z.string().min(1).max(128),
  // No max here: an amount over MAX_AMOUNT is a decline, not a malformed call.
  amount: z.number().int().positive().refine(Number.isSafeInteger),
  currency: z.literal("MXN"),
  merchant: z.object({ name: z.string().max(200), mcc: z.string().regex(/^\d{4}$/) }).optional(),
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;

export type DeclineReason =
  | "card_not_found"
  | "card_not_active"
  | "account_not_active"
  | "insufficient_credit"
  | "amount_over_maximum"
  | "account_frozen";

export interface AuthorizationDecision {
  networkAuthId: string;
  approved: boolean;
  declineReason: DeclineReason | null;
  holdId: string | null;
  duplicate: boolean;
}

const NETWORK: Actor = { type: "network" };
const SYSTEM: Actor = { type: "system" };

export class Authorizations {
  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly accounts: Accounts,
    private readonly config: { holdTtlDays: number; maxAmountCentavos: Centavos },
  ) {}

  // SPEND-01..05, SPEND-09, SPEND-11, SPEND-12. Lock order: the network
  // authorization ID (advisory lock), then the account row. Every check below
  // runs under the account row lock, so parallel purchases on one card are
  // decided one at a time against the same, current balance (SPEND-03).
  async authorize(tx: Tx, req: AuthorizationRequest): Promise<AuthorizationDecision> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `network_auth:${req.networkAuthId}`,
    ]);
    const previous = await this.findDecision(tx, req);
    if (previous) return previous;

    const accountId = await this.accounts.accountIdForCardToken(tx, req.cardToken);
    if (!accountId) return this.record(tx, req, null, { decline: "card_not_found" });

    let account = await this.accounts.lock(tx, accountId);
    if (!account) throw new Error(`card ${req.cardToken} points to a missing account`);
    account = await this.expireHolds(tx, account);

    // COL-05, SPEND-05: only an active account with an active card can spend.
    // FREEZE-02: a frozen account declines new purchases; nothing else changes.
    if (account.status === "frozen") {
      return this.record(tx, req, account.id, { decline: "account_frozen" });
    }
    if (account.status !== "active") {
      return this.record(tx, req, account.id, { decline: "account_not_active" });
    }
    const card = await this.accounts.card(tx, account.id);
    if (card.status !== "active") {
      return this.record(tx, req, account.id, { decline: "card_not_active" });
    }
    if (req.amount > this.config.maxAmountCentavos) {
      return this.record(tx, req, account.id, { decline: "amount_over_maximum" });
    }
    // SPEND-02, SPEND-12: credit_balance is deliberately not part of this.
    if (req.amount > availableCredit(account)) {
      return this.record(tx, req, account.id, { decline: "insufficient_credit" });
    }

    const now = this.clock.now();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO holds (account_id, network_auth_id, amount, status, expires_at, created_at)
       VALUES ($1, $2, $3, 'open', $4, $5) RETURNING id`,
      [
        account.id,
        req.networkAuthId,
        req.amount,
        new Date(now.getTime() + this.config.holdTtlDays * DAY_MS),
        now,
      ],
    );
    const holdId = rows[0]!.id;
    await this.accounts.update(
      tx,
      account,
      { held_total: addCentavos(account.held_total, req.amount) },
      { actor: NETWORK, action: "hold.created" },
    );
    return this.record(tx, req, account.id, { holdId });
  }

  // SPEND-09: a hold expires HOLD_TTL_DAYS after its creation. Expiry runs here,
  // under the account lock, before every decision, so a stale hold never blocks
  // a purchase even if the sweep job (M5) is late.
  async expireHolds(tx: Tx, account: Account): Promise<Account> {
    const { rows } = await tx.query<{ id: string; amount: number }>(
      `UPDATE holds SET status = 'expired', closed_at = $2
       WHERE account_id = $1 AND status = 'open' AND expires_at <= $2
       RETURNING id, amount`,
      [account.id, this.clock.now()],
    );
    if (rows.length === 0) return account;
    const released = rows.reduce<Centavos>((sum, h) => addCentavos(sum, h.amount), 0);
    for (const hold of rows) {
      await this.audit.write(tx, {
        actor: SYSTEM,
        action: "hold.expired",
        entityType: "hold",
        entityId: hold.id,
        before: { status: "open" },
        after: { status: "expired", amount: hold.amount },
      });
    }
    return this.accounts.update(
      tx,
      account,
      { held_total: account.held_total - released },
      { actor: SYSTEM, action: "holds.expired" },
    );
  }

  private async findDecision(
    tx: Tx,
    req: AuthorizationRequest,
  ): Promise<AuthorizationDecision | undefined> {
    const { rows } = await tx.query<{
      card_token: string;
      amount: number;
      approved: boolean;
      decline_reason: DeclineReason | null;
      hold_id: string | null;
    }>(
      `SELECT card_token, amount, approved, decline_reason, hold_id
       FROM authorizations WHERE network_auth_id = $1`,
      [req.networkAuthId],
    );
    const row = rows[0];
    if (!row) return undefined;
    if (row.card_token !== req.cardToken || row.amount !== req.amount) {
      throw conflict(
        "network_auth_conflict",
        "this network authorization ID was already used with a different card or amount",
      );
    }
    return {
      networkAuthId: req.networkAuthId,
      approved: row.approved,
      declineReason: row.decline_reason,
      holdId: row.hold_id,
      duplicate: true,
    };
  }

  private async record(
    tx: Tx,
    req: AuthorizationRequest,
    accountId: string | null,
    result: { decline: DeclineReason } | { holdId: string },
  ): Promise<AuthorizationDecision> {
    const holdId = "holdId" in result ? result.holdId : null;
    const declineReason = "decline" in result ? result.decline : null;
    await tx.query(
      `INSERT INTO authorizations
         (network_auth_id, card_token, account_id, amount, approved, decline_reason, hold_id, merchant, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.networkAuthId,
        req.cardToken,
        accountId,
        req.amount,
        holdId !== null,
        declineReason,
        holdId,
        req.merchant ? JSON.stringify(req.merchant) : null,
        this.clock.now(),
      ],
    );
    await this.audit.write(tx, {
      actor: NETWORK,
      action: holdId ? "authorization.approved" : "authorization.declined",
      entityType: "authorization",
      entityId: req.networkAuthId,
      before: null,
      after: { accountId, amount: req.amount, holdId, declineReason },
    });
    return {
      networkAuthId: req.networkAuthId,
      approved: holdId !== null,
      declineReason,
      holdId,
      duplicate: false,
    };
  }
}
