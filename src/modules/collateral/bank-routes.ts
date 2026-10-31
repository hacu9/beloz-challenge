import express, { type Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { requireBankSignature } from "../../http/middleware/auth.js";
import { withTx } from "../../platform/db/tx.js";
import { TransferReceived } from "./deposits.js";

// M6 adds payout result events to this union.
const BankEvent = z.discriminatedUnion("type", [TransferReceived]);

export function bankRoutes(deps: Deps): Router {
  const { config, clock, pool, deposits } = deps;
  const r = express.Router();

  // COL-02, SEC-04: only a signed bank webhook can move collateral.
  r.post(
    "/webhooks",
    requireBankSignature({
      secret: config.bankWebhookSecret,
      clock,
      toleranceSeconds: config.bankSignatureToleranceSeconds,
    }),
    async (req, res) => {
      const event = BankEvent.parse(req.body);
      const result = await withTx(pool, (tx) => deposits.receive(tx, event));
      res.status(200).json(result);
    },
  );

  return r;
}
