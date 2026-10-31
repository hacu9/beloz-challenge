import express, { type Router } from "express";
import type { Deps } from "../../deps.js";
import { requireNetworkKey } from "../../http/middleware/auth.js";
import { withTx } from "../../platform/db/tx.js";
import { AuthorizationRequest } from "./authorizations.js";
import { CaptureRequest, RefundRequest } from "./clearing.js";

// SPEND-01, SEC-03: only the card network calls these endpoints. A decline is
// a business answer (200 with approved=false), not an HTTP error.
export function networkRoutes(deps: Deps): Router {
  const { config, pool, authorizations, clearing } = deps;
  const r = express.Router();
  r.use(requireNetworkKey({ apiKey: config.networkApiKey }));

  r.post("/authorizations", async (req, res) => {
    const body = AuthorizationRequest.parse(req.body);
    const decision = await withTx(pool, (tx) => authorizations.authorize(tx, body));
    res.status(200).json(decision);
  });

  r.post("/authorizations/:networkAuthId/reversal", async (req, res) => {
    const id = String(req.params.networkAuthId);
    res.status(200).json(await withTx(pool, (tx) => clearing.reverse(tx, id)));
  });

  r.post("/captures", async (req, res) => {
    const body = CaptureRequest.parse(req.body);
    res.status(200).json(await withTx(pool, (tx) => clearing.capture(tx, body)));
  });

  r.post("/refunds", async (req, res) => {
    const body = RefundRequest.parse(req.body);
    res.status(200).json(await withTx(pool, (tx) => clearing.refund(tx, body)));
  });

  return r;
}
