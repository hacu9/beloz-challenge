import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { conflict, notFound } from "../../platform/errors.js";
import type { Account, Accounts } from "../accounts/accounts.js";
import type { Actor, AuditLog } from "../audit/audit.js";
import { transfer, type Ledger } from "../ledger/ledger.js";
import type { Payout, Payouts } from "../payouts/payouts.js";
import type { Authorizations } from "../spending/authorizations.js";
import type { ChargeOffs } from "./charge-offs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM: Actor = { type: "system" };

export interface ClosureStep {
  account: Account;
  /** Payouts created in this step; send them after the commit. */
  payouts: Payout[];
}

// Architecture §6: closing -> settling -> closed. Every step runs under the
// account row lock, like any other writer, so late captures, refunds and
// repayments interleave safely with it.
export class Closure {
  constructor(
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly audit: AuditLog,
    private readonly accounts: Accounts,
    private readonly authorizations: Authorizations,
    private readonly payouts: Payouts,
    private readonly chargeOffs: ChargeOffs,
    private readonly config: { closingCaptureWindowDays: number },
  ) {}

  // CLOSE-01: closing blocks new purchases at once. An account with no money
  // and no activity closes immediately.
  async requestClose(
    tx: Tx,
    accountId: string,
    caller: { type: "customer" | "ops"; id: string },
  ): Promise<Account> {
    const account = await this.accounts.lock(tx, accountId);
    if (!account || (caller.type === "customer" && account.customer_id !== caller.id)) {
      throw notFound("account not found");
    }
    if (!["pending_collateral", "active", "frozen"].includes(account.status)) {
      throw conflict("account_not_closable", `the account is already ${account.status}`);
    }
    const empty =
      account.status === "pending_collateral" &&
      account.credit_balance === 0 &&
      !(await this.payouts.hasOpenPayouts(tx, account.id));
    const next = await this.accounts.update(
      tx,
      account,
      empty ? { status: "closed" } : { status: "closing", closing_started_at: this.clock.now() },
      { actor: caller, action: empty ? "account.closed" : "account.closing" },
    );
    await this.accounts.setCardStatus(tx, account.id, "blocked", caller);
    return next;
  }

  // One step of the closure state machine for one account (CLOSE-03..08).
  // Idempotent: running it again changes nothing that is already done.
  async progress(tx: Tx, accountId: string): Promise<ClosureStep> {
    let account = await this.accounts.lock(tx, accountId);
    if (!account) throw notFound("account not found");
    account = await this.authorizations.expireHolds(tx, account);
    const created: Payout[] = [];

    if (account.status === "closing") {
      // CLOSE-03: wait for late captures, unless the card never worked.
      const windowEnds = account.activated_at
        ? account.closing_started_at!.getTime() + this.config.closingCaptureWindowDays * DAY_MS
        : 0;
      if (account.held_total > 0 || this.clock.now().getTime() < windowEnds) {
        return { account, payouts: created };
      }
      account = await this.accounts.update(
        tx,
        account,
        { status: "settling" },
        { actor: SYSTEM, action: "account.settling" },
      );
    }

    if (account.status === "settling" || account.status === "closed") {
      // CLOSE-08: in `closed` this only runs for money that arrived late.
      account = await this.settle(tx, account, created);
    }

    if (
      account.status === "settling" &&
      account.posted_debt === 0 &&
      account.held_total === 0 &&
      account.credit_limit === 0 &&
      account.credit_balance === 0 &&
      !(await this.payouts.hasOpenPayouts(tx, account.id))
    ) {
      // CLOSE-05, PAYOUT-07: closed only when every payout really left.
      account = await this.accounts.update(
        tx,
        account,
        { status: "closed" },
        { actor: SYSTEM, action: "account.closed" },
      );
    }
    return { account, payouts: created };
  }

  // CLOSE-04, CLOSE-06, CLOSE-07: free credit and collateral pay the debt
  // first; what the collateral cannot cover is charged off; what is left goes
  // back to the customer. Collateral already in a payout is not touched.
  private async settle(tx: Tx, start: Account, created: Payout[]): Promise<Account> {
    let account = await this.payouts.netAgainstDebt(tx, start, SYSTEM);
    const own = await this.ledger.customerAccounts(tx, account.id);
    // A1: a failed collateral payout did not leave; if money is owed, take it back.
    if (account.posted_debt > 0 || account.charged_off_outstanding > 0) {
      await this.payouts.releaseFailedCollateral(tx, account);
    }
    let available = account.credit_limit - (await this.payouts.reservedCollateral(tx, account.id));

    const applied = Math.min(available, account.posted_debt);
    if (applied > 0) {
      await this.ledger.post(tx, {
        kind: "collateral_application",
        accountId: account.id,
        lines: [
          { ledgerAccountId: own.customer_collateral, amount: applied },
          {
            ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_operating"),
            amount: applied,
          },
          { ledgerAccountId: own.customer_receivable, amount: -applied },
          {
            ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_collateral"),
            amount: -applied,
          },
        ],
      });
      account = await this.accounts.update(
        tx,
        account,
        {
          credit_limit: account.credit_limit - applied,
          posted_debt: account.posted_debt - applied,
        },
        { actor: SYSTEM, action: "collateral.applied" },
      );
      available -= applied;
    }

    // A1: collateral that came back (an unknown payout that turned out failed)
    // recovers debt that was charged off while it was away.
    const recovered = Math.min(available, account.charged_off_outstanding);
    if (recovered > 0) {
      const { journalId } = await this.ledger.post(tx, {
        kind: "recovery",
        accountId: account.id,
        lines: [
          { ledgerAccountId: own.customer_collateral, amount: recovered },
          {
            ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_operating"),
            amount: recovered,
          },
          {
            ledgerAccountId: await this.ledger.systemAccountId(tx, "chargeoff_loss"),
            amount: -recovered,
          },
          {
            ledgerAccountId: await this.ledger.systemAccountId(tx, "cash_collateral"),
            amount: -recovered,
          },
        ],
      });
      await this.chargeOffs.record(tx, account.id, "recovery", recovered, journalId);
      account = await this.accounts.update(
        tx,
        account,
        {
          credit_limit: account.credit_limit - recovered,
          charged_off_outstanding: account.charged_off_outstanding - recovered,
        },
        { actor: SYSTEM, action: "charge_off.recovered_from_collateral" },
      );
    }

    if (account.posted_debt > 0) {
      const shortfall = account.posted_debt;
      const { journalId } = await this.ledger.post(tx, {
        kind: "chargeoff",
        accountId: account.id,
        lines: transfer(
          await this.ledger.systemAccountId(tx, "chargeoff_loss"),
          own.customer_receivable,
          shortfall,
        ),
      });
      await this.chargeOffs.record(tx, account.id, "charge_off", shortfall, journalId);
      account = await this.accounts.update(
        tx,
        account,
        {
          posted_debt: 0,
          charged_off_outstanding: account.charged_off_outstanding + shortfall,
        },
        { actor: SYSTEM, action: "debt.charged_off" },
      );
    }

    // CLOSE-06: only now, with no debt left, does collateral go back.
    const remaining =
      account.credit_limit - (await this.payouts.reservedCollateral(tx, account.id));
    if (remaining > 0) {
      created.push(await this.payouts.createCollateralPayout(tx, account, remaining));
    }
    created.push(...(await this.payouts.createDue(tx, account.id)));
    // createDue re-reads the row under the same lock; return the fresh one.
    return (await this.accounts.lock(tx, account.id))!;
  }
}
