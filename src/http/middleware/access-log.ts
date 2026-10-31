import type { RequestHandler } from "express";
import type { Logger } from "../../platform/logger.js";

// OPS-02: one JSON line per request. Headers and bodies are not logged.
export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1000n) / 1000;
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, durationMs },
        "request",
      );
    });
    next();
  };
}
