import type { Clock } from "../../platform/clock.js";
import type { Queryable } from "../../platform/db/pool.js";
import type { Tx } from "../../platform/db/tx.js";
import { assertCentavos, sumCentavos, type Centavos } from "../../platform/money.js";
import { currentRequestId } from "../../platform/request-context.js";

// Chart of accounts (architecture §5). Sign convention: debit > 0, credit < 0.
export const SYSTEM_ACCOUNTS = {
  cash_collateral: "asset",
  cash_operating: "asset",
  network_payable: "liability",
  chargeoff_loss: "expense",
  unapplied_funds: "liability",
} as const;

export const CUSTOMER_ACCOUNTS = {
  customer_collateral: "liability",
  customer_receivable: "asset",
  customer_credit: "liability",
} as const;

export type SystemAccountCode = keyof typeof SYSTEM_ACCOUNTS;
export type CustomerAccountCode = keyof typeof CUSTOMER_ACCOUNTS;
export type CustomerLedgerAccounts = Record<CustomerAccountCode, string>;

export type JournalKind =
  | "deposit"
  | "capture"
  | "refund"
  | "repayment"
  | "collateral_application"
  | "collateral_payout"
  | "credit_payout"
  | "chargeoff"
  | "credit_netting"
  | "recovery"
  | "correction";

export interface JournalLineInput {
  ledgerAccountId: string;
  /** Debit > 0, credit < 0, never 0. */
  amount: Centavos;
}

export interface JournalInput {
  kind: JournalKind;
  accountId?: string;
  /** LEDGER-03: a correction references the entry it fixes. */
  reversesId?: string;
  lines: readonly JournalLineInput[];
}

export class UnbalancedJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbalancedJournalError";
  }
}

/** Shorthand: one debit and one credit of the same amount. */
export function transfer(debit: string, credit: string, amount: Centavos): JournalLineInput[] {
  assertCentavos(amount);
  if (amount <= 0) throw new UnbalancedJournalError("transfer amount must be positive");
  return [
    { ledgerAccountId: debit, amount },
    { ledgerAccountId: credit, amount: -amount },
  ];
}

export class Ledger {
  constructor(private readonly clock: Clock) {}

  // LEDGER-01, LEDGER-02: checked here and again by the deferred DB trigger.
  // The caller passes its open transaction, so the entry commits or rolls back
  // together with the change it records (LEDGER-06).
  async post(tx: Tx, input: JournalInput): Promise<{ journalId: string }> {
    if (input.lines.length < 2) {
      throw new UnbalancedJournalError("a journal entry needs at least two lines");
    }
    for (const line of input.lines) {
      assertCentavos(line.amount, "line amount");
      if (line.amount === 0) throw new UnbalancedJournalError("a line amount cannot be zero");
    }
    const total = sumCentavos(input.lines.map((l) => l.amount));
    if (total !== 0) {
      throw new UnbalancedJournalError(`journal lines sum to ${total}, not 0`);
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO journal_entries (kind, account_id, reverses_id, request_id, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.kind,
        input.accountId ?? null,
        input.reversesId ?? null,
        currentRequestId() ?? null,
        this.clock.now(),
      ],
    );
    const journalId = rows[0]!.id;
    await tx.query(
      `INSERT INTO journal_lines (journal_id, ledger_account_id, amount)
       SELECT $1, unnest($2::uuid[]), unnest($3::bigint[])`,
      [
        journalId,
        input.lines.map((l) => l.ledgerAccountId),
        input.lines.map((l) => String(l.amount)),
      ],
    );
    return { journalId };
  }

  async systemAccountId(db: Queryable, code: SystemAccountCode): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE code = $1 AND account_id IS NULL",
      [code],
    );
    if (!rows[0]) throw new Error(`system ledger account ${code} is missing`);
    return rows[0].id;
  }

  /** Creates the three ledger accounts of a customer account. */
  async openCustomerAccounts(tx: Tx, accountId: string): Promise<CustomerLedgerAccounts> {
    const codes = Object.keys(CUSTOMER_ACCOUNTS) as CustomerAccountCode[];
    const { rows } = await tx.query<{ id: string; code: CustomerAccountCode }>(
      `INSERT INTO ledger_accounts (code, account_id, type)
       SELECT unnest($1::text[]), $2, unnest($3::text[]) RETURNING id, code`,
      [codes, accountId, codes.map((c) => CUSTOMER_ACCOUNTS[c])],
    );
    return Object.fromEntries(rows.map((r) => [r.code, r.id])) as CustomerLedgerAccounts;
  }

  async customerAccounts(db: Queryable, accountId: string): Promise<CustomerLedgerAccounts> {
    const { rows } = await db.query<{ id: string; code: CustomerAccountCode }>(
      "SELECT id, code FROM ledger_accounts WHERE account_id = $1",
      [accountId],
    );
    if (rows.length !== Object.keys(CUSTOMER_ACCOUNTS).length) {
      throw new Error(`ledger accounts of account ${accountId} are incomplete`);
    }
    return Object.fromEntries(rows.map((r) => [r.code, r.id])) as CustomerLedgerAccounts;
  }

  /** Signed balance: debits minus credits. */
  async balance(db: Queryable, ledgerAccountId: string): Promise<Centavos> {
    const { rows } = await db.query<{ balance: number }>(
      "SELECT coalesce(sum(amount), 0) AS balance FROM journal_lines WHERE ledger_account_id = $1",
      [ledgerAccountId],
    );
    return rows[0]!.balance;
  }

  /** Q24: the sum of every line in the ledger. Always 0. */
  async trialBalance(db: Queryable): Promise<Centavos> {
    const { rows } = await db.query<{ total: number }>(
      "SELECT coalesce(sum(amount), 0) AS total FROM journal_lines",
    );
    return rows[0]!.total;
  }
}
