import express, { type Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { requireUser } from "../../http/middleware/auth.js";
import { requireIdempotencyKey, runIdempotent } from "../../http/middleware/idempotency.js";
import { notFound } from "../../platform/errors.js";
import { ResolveRequest, toPayoutView } from "./payouts.js";

const Statuses = z
  .string()
  .transform((s) => s.split(","))
  .pipe(z.array(z.enum(["requested", "completed", "failed", "unknown", "cancelled"])));

const ListQuery = z.object({
  status: Statuses.optional(),
  mismatch: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  accountId: z.string().uuid().optional(),
  stuck: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

// Ops only. Everything that needs a person: payouts in doubt, failed payouts,
// bank results that disagree with a manual resolution, money with an unknown
// reference.
export function opsRoutes(deps: Deps): Router {
  const { config, clock, pool, payouts } = deps;
  const r = express.Router();
  r.use(requireUser(["ops"], { secret: config.jwtSecret, clock }));

  r.get("/payouts", async (req, res) => {
    const q = ListQuery.parse(req.query);
    const rows = await payouts.list(pool, {
      stuckBefore: new Date(clock.now().getTime() - config.payoutStuckMinutes * 60_000),
      ...(q.stuck !== undefined ? { stuck: q.stuck } : {}),
      ...(q.status ? { statuses: q.status } : {}),
      ...(q.mismatch !== undefined ? { mismatch: q.mismatch } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
    });
    res.json({ payouts: rows.map(toPayoutView) });
  });

  // PAYOUT-04. A retry is sent after the commit, outside the transaction.
  r.post("/payouts/:id/resolve", requireIdempotencyKey(), async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("payout not found");
    const body = ResolveRequest.parse(req.body);
    const ops = req.principal?.type === "ops" ? req.principal : undefined;
    if (!ops) throw new Error("route needs requireUser(ops)");

    const result = await runIdempotent(pool, clock, req.idempotency!, async (tx) => {
      const { payout, needsSubmit } = await payouts.resolve(tx, id.data, body, ops);
      return { status: 200, body: { payout: toPayoutView(payout), needsSubmit } };
    });
    if (!result.replayed && result.body.needsSubmit === true) {
      await payouts.submit(pool, id.data);
    }
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  });

  r.get("/unapplied-funds", async (_req, res) => {
    const { rows } = await pool.query<{
      bank_txn_id: string;
      reference: string;
      amount: number;
      received_at: Date;
    }>(
      `SELECT bank_txn_id, reference, amount, received_at FROM bank_transactions
       WHERE outcome = 'unapplied' ORDER BY received_at`,
    );
    res.json({
      unapplied: rows.map((r) => ({
        bankTxnId: r.bank_txn_id,
        reference: r.reference,
        amount: r.amount,
        receivedAt: r.received_at.toISOString(),
      })),
    });
  });

  return r;
}
