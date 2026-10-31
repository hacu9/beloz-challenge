import type { Clock } from "../platform/clock.js";
import { BANK_SIGNATURE_HEADER, bankSignature } from "../http/middleware/auth.js";

// Simulated bank (Q5). M2 has only the webhook signer; M3 adds the webhook
// sender and M6 the payout endpoint.
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
