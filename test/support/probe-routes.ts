import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { z } from "zod";
import type { Deps } from "../../src/deps.js";
import {
  requireBankSignature,
  requireNetworkKey,
  requireUser,
} from "../../src/http/middleware/auth.js";
import { requireIdempotencyKey, sendIdempotent } from "../../src/http/middleware/idempotency.js";
import { transfer } from "../../src/modules/ledger/ledger.js";
import { amountSchema } from "../../src/platform/money.js";

// Test-only routes that exercise the real M2 middleware before the business
// endpoints exist (M3+). They are mounted only by the tests.
export function mountProbeRoutes(app: Express, deps: Deps): void {
  const { config, clock } = deps;
  const r = express.Router();

  r.get("/customer", requireUser(["customer"], { secret: config.jwtSecret, clock }), (req, res) => {
    res.json({ principal: req.principal });
  });
  r.get("/ops", requireUser(["ops"], { secret: config.jwtSecret, clock }), (req, res) => {
    res.json({ principal: req.principal });
  });
  r.post("/network", requireNetworkKey({ apiKey: config.networkApiKey }), (req, res) => {
    res.json({ principal: req.principal });
  });
  r.post(
    "/bank",
    requireBankSignature({
      secret: config.bankWebhookSecret,
      clock,
      toleranceSeconds: config.bankSignatureToleranceSeconds,
    }),
    (req, res) => {
      res.json({ principal: req.principal, body: req.body as unknown });
    },
  );

  const TransferBody = z.object({
    amount: amountSchema(config.maxAmountCentavos),
    failAfterPost: z.boolean().optional(),
    /** Keeps the transaction open, so parallel requests truly overlap in the DB. */
    holdMs: z.number().int().min(0).max(2_000).optional(),
  });

  // A money call: posts a ledger transfer and an audit row, idempotently.
  r.post(
    "/transfers",
    requireUser(["customer", "ops"], { secret: config.jwtSecret, clock }),
    requireIdempotencyKey(),
    async (req, res) => {
      const body = TransferBody.parse(req.body);
      await sendIdempotent(req, res, deps, async (tx) => {
        const debit = await deps.ledger.systemAccountId(tx, "cash_operating");
        const credit = await deps.ledger.systemAccountId(tx, "unapplied_funds");
        const { journalId } = await deps.ledger.post(tx, {
          kind: "correction",
          lines: transfer(debit, credit, body.amount),
        });
        await deps.audit.write(tx, {
          actor: { type: "customer", id: req.principal?.type === "customer" ? req.principal.id : "" },
          action: "probe.transfer",
          entityType: "probe",
          entityId: req.idempotency!.key,
          before: null,
          after: { journalId, amount: body.amount },
        });
        if (body.holdMs) await tx.query("SELECT pg_sleep($1)", [body.holdMs / 1000]);
        if (body.failAfterPost) throw new Error("simulated failure after the post");
        return { status: 201, body: { journalId, amount: body.amount, nonce: randomUUID() } };
      });
    },
  );

  r.get("/boom", () => {
    throw new Error("secret internal detail");
  });

  app.use("/test", r);
}
