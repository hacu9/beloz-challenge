import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import type { Centavos } from "../../platform/money.js";

// CLOSE-07 / CLOSE-09: the append-only collections log. The journal entry is
// posted by the caller; this records which part of it was a charge-off or a
// recovery, so reconcile can check `charged_off_outstanding` against it.
export class ChargeOffs {
  constructor(private readonly clock: Clock) {}

  async record(
    tx: Tx,
    accountId: string,
    kind: "charge_off" | "recovery",
    amount: Centavos,
    journalId: string,
  ): Promise<void> {
    if (amount <= 0) return;
    await tx.query(
      `INSERT INTO charge_offs (account_id, kind, amount, journal_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [accountId, kind, amount, journalId, this.clock.now()],
    );
  }
}

/**
 * CLOSE-09: how incoming customer money is split. Open debt first, then
 * charged-off debt, and only the rest becomes credit.
 */
export function splitIncoming(
  amount: Centavos,
  account: { posted_debt: Centavos; charged_off_outstanding: Centavos },
  opts: { payOpenDebt: boolean },
): { toDebt: Centavos; toRecovery: Centavos; toCredit: Centavos } {
  const toDebt = opts.payOpenDebt ? Math.min(amount, account.posted_debt) : 0;
  const toRecovery = Math.min(amount - toDebt, account.charged_off_outstanding);
  return { toDebt, toRecovery, toCredit: amount - toDebt - toRecovery };
}
