import { z } from "zod";
import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { conflict } from "../../platform/errors.js";
import { addCentavos, type Centavos } from "../../platform/money.js";
import type { Account, Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import { splitIncoming, type ChargeOffs } from "../closure/charge-offs.js";
import { transfer, type JournalLineInput, type Ledger } from "../ledger/ledger.js";

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
  | "unapplied"
  | "repayment_applied";

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
    private readonly chargeOffs: ChargeOffs,
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
      ({ outcome, journalId } = await this.applyRepayment(tx, target.account, event.amount));
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
        {
          status: "active",
          credit_limit: addCentavos(account.credit_limit, amount),
          activated_at: this.clock.now(),
        },
        { actor: BANK, action: "account.activated" },
      );
      await this.accounts.setCardStatus(tx, account.id, "active", BANK);
      return { outcome: "collateral_confirmed", journalId };
    }

    // COL-07, COL-09: the money is the customer's. The cash landed in the
    // segregated collateral bank account, so the ledger says so. B3: it first
    // recovers charged-off debt; open debt it never pays (D-M6-1). The rest is
    // returned as a return of this transfer.
    const split = splitIncoming(amount, account, { payOpenDebt: false });
    const lines: JournalLineInput[] = [
      { ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_collateral"), amount },
    ];
    if (split.toRecovery > 0) {
      lines.push({
        ledgerAccountId: await this.ledger.systemAccountId(tx, "chargeoff_loss"),
        amount: -split.toRecovery,
      });
    }
    if (split.toCredit > 0) {
      lines.push({ ledgerAccountId: own.customer_credit, amount: -split.toCredit });
    }
    const { journalId } = await this.ledger.post(tx, {
      kind: "deposit",
      accountId: account.id,
      lines,
    });
    await this.chargeOffs.record(tx, account.id, "recovery", split.toRecovery, journalId);
    const outcome =
      account.status === "pending_collateral" ? "credited_below_minimum" : "credited_for_payback";
    await this.accounts.update(
      tx,
      account,
      {
        charged_off_outstanding: account.charged_off_outstanding - split.toRecovery,
        credit_balance: addCentavos(account.credit_balance, split.toCredit),
        credit_returnable: addCentavos(account.credit_returnable, split.toCredit),
      },
      { actor: BANK, action: `account.${outcome}` },
    );
    return { outcome, journalId };
  }

  // REPAY-01..03: a repayment pays the debt first; the rest is credit that
  // nets against new debt or is paid back (PAYOUT-10, REPAY-04). Any account
  // state accepts it: the money already landed (CLOSE-08).
  private async applyRepayment(
    tx: Tx,
    account: Account,
    amount: Centavos,
  ): Promise<{ outcome: DepositOutcome; journalId: string }> {
    const own = await this.ledger.customerAccounts(tx, account.id);
    // CLOSE-09: open debt, then charged-off debt (a recovery reduces the
    // loss; it must not come back to the customer as credit), then credit.
    const { toDebt, toRecovery, toCredit } = splitIncoming(amount, account, {
      payOpenDebt: true,
    });
    const lines: JournalLineInput[] = [
      { ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_operating"), amount },
    ];
    if (toDebt > 0) lines.push({ ledgerAccountId: own.customer_receivable, amount: -toDebt });
    if (toRecovery > 0) {
      lines.push({
        ledgerAccountId: await this.ledger.systemAccountId(tx, "chargeoff_loss"),
        amount: -toRecovery,
      });
    }
    if (toCredit > 0) lines.push({ ledgerAccountId: own.customer_credit, amount: -toCredit });
    const { journalId } = await this.ledger.post(tx, {
      kind: "repayment",
      accountId: account.id,
      lines,
    });
    await this.chargeOffs.record(tx, account.id, "recovery", toRecovery, journalId);
    await this.accounts.update(
      tx,
      account,
      {
        posted_debt: account.posted_debt - toDebt,
        charged_off_outstanding: account.charged_off_outstanding - toRecovery,
        credit_balance: addCentavos(account.credit_balance, toCredit),
      },
      { actor: BANK, action: "account.repayment_applied" },
    );
    return { outcome: "repayment_applied", journalId };
  }
}
