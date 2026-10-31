import { randomUUID } from "node:crypto";
import type { Clock } from "../platform/clock.js";
import { BANK_SIGNATURE_HEADER, bankSignature } from "../http/middleware/auth.js";

// Simulated bank (Q5). It signs webhooks like a real bank would. M6 adds the
// payout endpoint.
export function signWebhook(
  body: unknown,
  secret: string,
  clock: Clock,
): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(clock.now().getTime() / 1000);
  const signature = bankSignature(secret, timestamp, Buffer.from(payload));
  return {
    payload,
    headers: {
      "content-type": "application/json",
      [BANK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
    },
  };
}

export interface TransferArgs {
  reference: string;
  amount: number;
  bankTxnId?: string;
}

export function transferReceived(args: TransferArgs) {
  return {
    type: "transfer.received" as const,
    bankTxnId: args.bankTxnId ?? `spei_${randomUUID()}`,
    reference: args.reference,
    amount: args.amount,
    currency: "MXN" as const,
  };
}

export class FakeBank {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  /** A customer sends money by SPEI to one of their account references. */
  async sendTransfer(args: TransferArgs): Promise<{ status: number; body: unknown }> {
    const { payload, headers } = signWebhook(transferReceived(args), this.secret, this.clock);
    const res = await fetch(`${this.baseUrl}/v1/bank/webhooks`, {
      method: "POST",
      headers,
      body: payload,
    });
    return { status: res.status, body: await res.json() };
  }
}
