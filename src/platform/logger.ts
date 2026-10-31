import { pino, type DestinationStream, type Logger } from "pino";
import { currentRequestId } from "./request-context.js";

export type { Logger };

// SEC-06: these paths never reach a log line, whatever object a caller logs.
export const REDACT_PATHS = [
  "authorization",
  "password",
  "token",
  "secret",
  "signature",
  "*.authorization",
  "*.password",
  "*.token",
  "*.secret",
  "*.signature",
  'headers["x-network-key"]',
  'headers["x-bank-signature"]',
  'req.headers["x-network-key"]',
  'req.headers["x-bank-signature"]',
  "req.headers.authorization",
];

// OPS-02: JSON lines; every line carries the request ID of the current request.
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "acme-card" },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      mixin() {
        const requestId = currentRequestId();
        return requestId ? { requestId } : {};
      },
    },
    destination,
  );
}
