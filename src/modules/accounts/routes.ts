import express, { type Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { requireUser } from "../../http/middleware/auth.js";
import { requireIdempotencyKey, sendIdempotent } from "../../http/middleware/idempotency.js";
import { notFound } from "../../platform/errors.js";
import { toView } from "./accounts.js";

const AccountId = z.string().uuid();

function userOf(req: express.Request): { type: "customer" | "ops"; id: string } {
  const p = req.principal;
  if (p?.type !== "customer" && p?.type !== "ops") throw new Error("route needs requireUser");
  return p;
}

export function accountRoutes(deps: Deps): Router {
  const { config, clock, pool, accounts } = deps;
  const r = express.Router();
  const customer = requireUser(["customer"], { secret: config.jwtSecret, clock });
  const customerOrOps = requireUser(["customer", "ops"], { secret: config.jwtSecret, clock });

  // COL-01
  r.post("/", customer, requireIdempotencyKey(), async (req, res) => {
    const caller = userOf(req);
    await sendIdempotent(req, res, deps, async (tx) => {
      const { account, card } = await accounts.open(tx, caller.id, caller);
      return { status: 201, body: { ...toView(account, card) } };
    });
  });

  r.get("/", customer, async (req, res) => {
    const rows = await accounts.listForCustomer(pool, userOf(req).id);
    res.json({ accounts: rows.map((r) => toView(r.account, r.card)) });
  });

  // SEC-02: an unknown ID, a malformed ID and another customer's ID all look the same.
  r.get("/:id", customerOrOps, async (req, res) => {
    const id = AccountId.safeParse(req.params.id);
    if (!id.success) throw notFound("account not found");
    const found = await accounts.findForCaller(pool, id.data, userOf(req));
    if (!found) throw notFound("account not found");
    res.json(toView(found.account, found.card));
  });

  return r;
}
