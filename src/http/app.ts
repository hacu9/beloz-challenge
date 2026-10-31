import express, { type Express } from "express";
import type { Deps } from "../deps.js";
import { accountRoutes } from "../modules/accounts/routes.js";
import { bankRoutes } from "../modules/collateral/bank-routes.js";
import { opsRoutes } from "../modules/payouts/ops-routes.js";
import { networkRoutes } from "../modules/spending/network-routes.js";
import { accessLog } from "./middleware/access-log.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { requestId } from "./middleware/request-id.js";

export interface AppOptions {
  /** Mounts extra routers before the 404 handler. Tests use it for probe routes. */
  mount?: (app: Express, deps: Deps) => void;
}

export function buildApp(deps: Deps, opts: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestId());
  app.use(accessLog(deps.logger));
  // Keep the exact bytes: the bank HMAC and the idempotency hash use them.
  app.use(
    express.json({
      limit: "64kb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get("/health", async (_req, res) => {
    await deps.pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  app.use("/v1/accounts", accountRoutes(deps));
  app.use("/v1/bank", bankRoutes(deps));
  app.use("/v1/network", networkRoutes(deps));
  app.use("/v1/ops", opsRoutes(deps));

  opts.mount?.(app, deps);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
