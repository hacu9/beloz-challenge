// The outgoing side of the bank (Q5: simulated). A real bank SPEI API answers
// a payout request synchronously with "accepted" or "rejected"; the final
// result comes later by signed webhook (payout.completed / payout.failed).

export interface PayoutInstruction {
  /** Our payout ID, sent as the bank's idempotency key (PAYOUT-06). */
  payoutId: string;
  amount: number;
  sourceAccount: "cash_collateral" | "cash_operating";
  destinationClabe: string;
}

export type PayoutSubmission = "accepted" | "rejected";

/** Thrown when we cannot tell whether the bank took the payout (PAYOUT-02). */
export class BankUnknownOutcomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BankUnknownOutcomeError";
  }
}

export interface BankClient {
  /**
   * Resolves "accepted" or "rejected" when the bank answered clearly.
   * Throws BankUnknownOutcomeError on a timeout or an unclear answer.
   */
  requestPayout(instruction: PayoutInstruction): Promise<PayoutSubmission>;
}
