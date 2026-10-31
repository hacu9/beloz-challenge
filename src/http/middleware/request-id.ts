import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { runWithContext } from "../../platform/request-context.js";

const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

// OPS-02: accept a caller's X-Request-Id if it is safe to log, else make one.
// The ID flows to every log line, journal entry and audit row of the request.
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader("X-Request-Id", id);
    runWithContext({ requestId: id }, next);
  };
}
