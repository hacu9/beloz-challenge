import { randomInt, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Clock } from "../../platform/clock.js";
import type { Queryable } from "../../platform/db/pool.js";
import type { Tx } from "../../platform/db/tx.js";
import { conflict } from "../../platform/errors.js";
import type { Centavos } from "../../platform/money.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import type { Ledger } from "../ledger/ledger.js";

export type AccountStatus =
  "pending_collateral" | "active" | "frozen" | "closing" | "settling" | "closed";

export type CardStatus = "inactive" | "active" | "blocked";

// Architecture §6. Any transition not listed here is a bug, not a user error.
const TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  // An account with money but no collateral closes through closing/settling,
  // so its credited deposits are returned first (CLOSE-01).
  pending_collateral: ["active", "closing", "closed"],
  active: ["frozen", "closing"],
  frozen: ["active", "closing"],
  closing: ["settling"],
  settling: ["closed"],
  closed: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: AccountStatus, to: AccountStatus) {
    super(`illegal account transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: AccountStatus, to: AccountStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);
}

export interface Account {
  id: string;
  customer_id: string;
  status: AccountStatus;
  credit_limit: Centavos;
  posted_debt: Centavos;
  held_total: Centavos;
  credit_balance: Centavos;
  /** Part of credit_balance whose cash is in cash_collateral; returned, never netted (D-M6-1). */
  credit_returnable: Centavos;
  payout_clabe: string | null;
  /** CLOSE-07/09: charged-off debt the customer still owes (collections). */
  charged_off_outstanding: Centavos;
  activated_at: Date | null;
  collateral_reference: string;
  repayment_reference: string;
  version: number;
  closing_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Card {
  id: string;
  account_id: string;
  token: string;
  last4: string;
  status: CardStatus;
}

const UPDATABLE = [
  "status",
  "credit_limit",
  "posted_debt",
  "held_total",
  "credit_balance",
  "credit_returnable",
  "charged_off_outstanding",
  "payout_clabe",
  "activated_at",
  "closing_started_at",
] as const;

type AccountChanges = Partial<Pick<Account, (typeof UPDATABLE)[number]>>;

export interface AccountView {
  id: string;
  status: AccountStatus;
  currency: "MXN";
  creditLimit: Centavos;
  /** Never below 0 in the view (D-M5-2); the excess shows as overLimit. */
  availableCredit: Centavos;
  /** How far a capture pushed the account over its limit (SPEND-06). */
  overLimit: Centavos;
  postedDebt: Centavos;
  heldTotal: Centavos;
  creditBalance: Centavos;
  collateralReference: string;
  payoutClabeLast4: string | null;
  chargedOffOutstanding: Centavos;
  closingStartedAt: string | null;
  repaymentReference: string;
  card: { last4: string; status: CardStatus };
  createdAt: string;
}

/** SPEND-02: what a new authorization may still use. Negative after an over-limit capture. */
export function availableCredit(a: Pick<Account, "credit_limit" | "posted_debt" | "held_total">) {
  return a.credit_limit - a.posted_debt - a.held_total;
}

export function toView(account: Account, card: Card): AccountView {
  const available = availableCredit(account);
  return {
    id: account.id,
    status: account.status,
    currency: "MXN",
    creditLimit: account.credit_limit,
    availableCredit: Math.max(0, available),
    overLimit: Math.max(0, -available),
    postedDebt: account.posted_debt,
    heldTotal: account.held_total,
    creditBalance: account.credit_balance,
    collateralReference: account.collateral_reference,
    payoutClabeLast4: account.payout_clabe?.slice(-4) ?? null,
    chargedOffOutstanding: account.charged_off_outstanding,
    closingStartedAt: account.closing_started_at?.toISOString() ?? null,
    repaymentReference: account.repayment_reference,
    card: { last4: card.last4, status: card.status },
    createdAt: account.created_at.toISOString(),
  };
}

// Simulated SPEI CLABE: 18 digits. The "999" prefix is not a real bank code.
function fakeClabe(): string {
  let digits = "999";
  while (digits.length < 18) digits += String(randomInt(0, 10));
  return digits;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as pg.DatabaseError;
  return e?.code === "23505" && e.constraint === constraint;
}

export const toAudit = (a: Account) => ({
  status: a.status,
  creditLimit: a.credit_limit,
  postedDebt: a.posted_debt,
  heldTotal: a.held_total,
  creditBalance: a.credit_balance,
  creditReturnable: a.credit_returnable,
  chargedOffOutstanding: a.charged_off_outstanding,
});

// The accounts module owns the accounts and cards tables. Other modules read
// and change an account only through this class, inside their transaction.
export class Accounts {
  constructor(
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
  ) {}

  /** COL-01: a new account waits for collateral; its card is inactive. */
  async open(
    tx: Tx,
    customerId: string,
    payoutClabe: string,
    actor: Actor,
  ): Promise<{ account: Account; card: Card }> {
    const now = this.clock.now();
    let account: Account;
    try {
      const { rows } = await tx.query<Account>(
        `INSERT INTO accounts (customer_id, status, collateral_reference, repayment_reference, payout_clabe, created_at, updated_at)
         VALUES ($1, 'pending_collateral', $2, $3, $4, $5, $5) RETURNING *`,
        [customerId, fakeClabe(), fakeClabe(), payoutClabe, now],
      );
      account = rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err, "accounts_one_open_per_customer")) {
        throw conflict("account_exists", "the customer already has an open account");
      }
      throw err;
    }

    // SEC-05: the simulated issuer returns a network token and the last 4
    // digits. The service never sees or stores a full card number.
    const { rows: cards } = await tx.query<Card>(
      `INSERT INTO cards (account_id, token, last4, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'inactive', $4, $4) RETURNING id, account_id, token, last4, status`,
      [
        account.id,
        `tok_${randomUUID().replaceAll("-", "")}`,
        String(randomInt(0, 10_000)).padStart(4, "0"),
        now,
      ],
    );
    await this.ledger.openCustomerAccounts(tx, account.id);
    await this.audit.write(tx, {
      actor,
      action: "account.opened",
      entityType: "account",
      entityId: account.id,
      before: null,
      after: toAudit(account),
    });
    return { account, card: cards[0]! };
  }

  /** Row lock: every writer on an account serialises here (architecture §7). */
  async lock(tx: Tx, accountId: string): Promise<Account | undefined> {
    const { rows } = await tx.query<Account>("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [
      accountId,
    ]);
    return rows[0];
  }

  /** OQ-07: finds and locks the account that owns a bank reference. */
  async lockByReference(
    tx: Tx,
    reference: string,
  ): Promise<{ account: Account; purpose: "collateral" | "repayment" } | undefined> {
    const { rows } = await tx.query<Account>(
      `SELECT * FROM accounts
       WHERE collateral_reference = $1 OR repayment_reference = $1 FOR UPDATE`,
      [reference],
    );
    const account = rows[0];
    if (!account) return undefined;
    return {
      account,
      purpose: account.collateral_reference === reference ? "collateral" : "repayment",
    };
  }

  /** Applies changes to a locked account. Checks the transition and writes the audit row. */
  async update(
    tx: Tx,
    before: Account,
    changes: AccountChanges,
    audit: { actor: Actor; action: string },
  ): Promise<Account> {
    if (changes.status !== undefined && changes.status !== before.status) {
      assertTransition(before.status, changes.status);
    }
    const columns = Object.keys(changes) as (keyof AccountChanges)[];
    // Column names go into the SQL text, so only the known ones pass.
    for (const c of columns) {
      if (!UPDATABLE.includes(c)) throw new Error(`account column ${String(c)} is not updatable`);
    }
    const sets = columns.map((c, i) => `${c} = $${i + 4}`);
    const { rows } = await tx.query<Account>(
      `UPDATE accounts SET ${[...sets, "version = version + 1", "updated_at = $3"].join(", ")}
       WHERE id = $1 AND version = $2 RETURNING *`,
      [before.id, before.version, this.clock.now(), ...columns.map((c) => changes[c])],
    );
    const after = rows[0];
    // The row lock makes this impossible; the version check proves it.
    if (!after) throw new Error(`account ${before.id} changed under its lock`);
    await this.audit.write(tx, {
      actor: audit.actor,
      action: audit.action,
      entityType: "account",
      entityId: before.id,
      before: toAudit(before),
      after: toAudit(after),
    });
    return after;
  }

  async setCardStatus(tx: Tx, accountId: string, status: CardStatus, actor: Actor): Promise<Card> {
    const { rows: before } = await tx.query<Card>(
      "SELECT id, account_id, token, last4, status FROM cards WHERE account_id = $1 FOR UPDATE",
      [accountId],
    );
    const { rows } = await tx.query<Card>(
      `UPDATE cards SET status = $2, updated_at = $3 WHERE account_id = $1
       RETURNING id, account_id, token, last4, status`,
      [accountId, status, this.clock.now()],
    );
    await this.audit.write(tx, {
      actor,
      action: `card.${status}`,
      entityType: "card",
      entityId: rows[0]!.id,
      before: { status: before[0]?.status },
      after: { status },
    });
    return rows[0]!;
  }

  /** SEC-02: a customer sees only their own account; anything else is "not found". */
  async findForCaller(
    db: Queryable,
    accountId: string,
    caller: { type: "customer" | "ops"; id: string },
  ): Promise<{ account: Account; card: Card } | undefined> {
    const { rows } = await db.query<Account>(
      `SELECT * FROM accounts WHERE id = $1 AND ($2::uuid IS NULL OR customer_id = $2)`,
      [accountId, caller.type === "customer" ? caller.id : null],
    );
    const account = rows[0];
    if (!account) return undefined;
    return { account, card: await this.card(db, account.id) };
  }

  async listForCustomer(db: Queryable, customerId: string) {
    const { rows } = await db.query<Account>(
      "SELECT * FROM accounts WHERE customer_id = $1 ORDER BY created_at DESC",
      [customerId],
    );
    return Promise.all(rows.map(async (a) => ({ account: a, card: await this.card(db, a.id) })));
  }

  async accountIdForCardToken(db: Queryable, token: string): Promise<string | undefined> {
    const { rows } = await db.query<{ account_id: string }>(
      "SELECT account_id FROM cards WHERE token = $1",
      [token],
    );
    return rows[0]?.account_id;
  }

  async card(db: Queryable, accountId: string): Promise<Card> {
    const { rows } = await db.query<Card>(
      "SELECT id, account_id, token, last4, status FROM cards WHERE account_id = $1",
      [accountId],
    );
    if (!rows[0]) throw new Error(`account ${accountId} has no card`);
    return rows[0];
  }
}
