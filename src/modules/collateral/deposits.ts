import { z } from "zod";
import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { AppError, conflict } from "../../platform/errors.js";
import { addCentavos, type Centavos } from "../../platform/money.js";
import type { Account, Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import { transfer, type Ledger } from "../ledger/ledger.js";

// A SPEI-style transfer that already landed in one of Acme's bank accounts.
// The bank does not know why the money came; the reference tells us (OQ-07).
export const TransferReceived = z.object({
  type: z.literal("transfer.received"),
  bankTxnId: z.string().min(1).max(128),
  reference: z.string().min(1).max(64),
  // No MAX_AMOUNT here: the money already landed, so a large transfer is
  // recorded, never refused (COL-06).
  amount: z.number().int().positive().refine(Number.isSafeInteger),
  currency: z.literal("MXN"),
});
export type TransferReceived = z.infer<typeof TransferReceived>;

export type DepositOutcome =
  | "collateral_confirmed"
  | "credited_below_minimum"
  | "credited_for_payback"
  | "unapplied";

export interface DepositResult {
  bankTxnId: string;
  outcome: DepositOutcome;
  accountId: string | null;
  duplicate: boolean;
}

const BANK: Actor = { type: "bank" };

export class Deposits {
  constructor(
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
    private readonly accounts: Accounts,
    private readonly minDepositCentavos: Centavos,
  ) {}

  // COL-03..09. Lock order: the bank transaction ID (advisory lock), then the
  // account row. A parallel duplicate waits on the first lock and then sees
  // the stored result, so a transfer is applied exactly once.
  async receive(tx: Tx, event: TransferReceived): Promise<DepositResult> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `bank_txn:${event.bankTxnId}`,
    ]);
    const { rows: seen } = await tx.query<{
      outcome: DepositOutcome;
      account_id: string | null;
      reference: string;
      amount: number;
    }>(
      "SELECT outcome, account_id, reference, amount FROM bank_transactions WHERE bank_txn_id = $1",
      [event.bankTxnId],
    );
    const first = seen[0];
    if (first) {
      if (first.reference !== event.reference || first.amount !== event.amount) {
        throw conflict(
          "bank_txn_conflict",
          "this bank transaction ID was already received with a different reference or amount",
        );
      }
      return {
        bankTxnId: event.bankTxnId,
        outcome: first.outcome,
        accountId: first.account_id,
        duplicate: true,
      };
    }

    const target = await this.accounts.lockByReference(tx, event.reference);
    let outcome: DepositOutcome;
    let journalId: string;

    if (!target) {
      // COL-08: keep the money in suspense; ops finds it in bank_transactions.
      ({ journalId } = await this.ledger.post(tx, {
        kind: "deposit",
        lines: transfer(
          await this.ledger.systemAccountId(tx, "cash_operating"),
          await this.ledger.systemAccountId(tx, "unapplied_funds"),
          event.amount,
        ),
      }));
      outcome = "unapplied";
    } else if (target.purpose === "repayment") {
      // Rolls back and records nothing, so the bank retries once M6 ships.
      throw new AppError(501, "not_implemented", "repayments are not supported yet (M6)");
    } else {
      ({ outcome, journalId } = await this.applyToAccount(tx, target.account, event.amount));
    }

    await tx.query(
      `INSERT INTO bank_transactions
         (bank_txn_id, kind, reference, account_id, amount, outcome, journal_id, received_at)
       VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7)`,
      [
        event.bankTxnId,
        event.reference,
        target?.account.id ?? null,
        event.amount,
        outcome,
        journalId,
        this.clock.now(),
      ],
    );
    await this.audit.write(tx, {
      actor: BANK,
      action: `deposit.${outcome}`,
      entityType: "bank_transaction",
      entityId: event.bankTxnId,
      before: null,
      after: { reference: event.reference, amount: event.amount, accountId: target?.account.id },
    });
    return {
      bankTxnId: event.bankTxnId,
      outcome,
      accountId: target?.account.id ?? null,
      duplicate: false,
    };
  }

  private async applyToAccount(
    tx: Tx,
    account: Account,
    amount: Centavos,
  ): Promise<{ outcome: DepositOutcome; journalId: string }> {
    const own = await this.ledger.customerAccounts(tx, account.id);

    if (account.status === "pending_collateral" && amount >= this.minDepositCentavos) {
      // COL-04: journal, limit (Q16: 1:1), activation and card in one transaction.
      const { journalId } = await this.ledger.post(tx, {
        kind: "deposit",
        accountId: account.id,
        lines: transfer(
          await this.ledger.systemAccountId(tx, "cash_collateral"),
          own.customer_collateral,
          amount,
        ),
      });
      await this.accounts.update(
        tx,
        account,
        { status: "active", credit_limit: addCentavos(account.credit_limit, amount) },
        { actor: BANK, action: "account.activated" },
      );
      await this.accounts.setCardStatus(tx, account.id, "active", BANK);
      return { outcome: "collateral_confirmed", journalId };
    }

    // COL-07, COL-09: the money is the customer's. Credit it; the payout
    // module (M6) pays the credit balance back. The cash landed in the
    // segregated collateral bank account, so the ledger says so.
    const { journalId } = await this.ledger.post(tx, {
      kind: "deposit",
      accountId: account.id,
      lines: transfer(
        await this.ledger.systemAccountId(tx, "cash_collateral"),
        own.customer_credit,
        amount,
      ),
    });
    const outcome =
      account.status === "pending_collateral" ? "credited_below_minimum" : "credited_for_payback";
    await this.accounts.update(
      tx,
      account,
      { credit_balance: addCentavos(account.credit_balance, amount) },
      { actor: BANK, action: `account.${outcome}` },
    );
    return { outcome, journalId };
  }
}
