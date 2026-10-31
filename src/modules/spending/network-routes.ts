import express, { type Router } from "express";
import type { Deps } from "../../deps.js";
import { requireNetworkKey } from "../../http/middleware/auth.js";
import { withTx } from "../../platform/db/tx.js";
import { AuthorizationRequest } from "./authorizations.js";

// SPEND-01, SEC-03: only the card network calls these endpoints. A decline is
// a business answer (200 with approved=false), not an HTTP error.
export function networkRoutes(deps: Deps): Router {
  const { config, pool, authorizations } = deps;
  const r = express.Router();
  r.use(requireNetworkKey({ apiKey: config.networkApiKey }));

  r.post("/authorizations", async (req, res) => {
    const body = AuthorizationRequest.parse(req.body);
    const decision = await withTx(pool, (tx) => authorizations.authorize(tx, body));
    res.status(200).json(decision);
  });

  return r;
}
