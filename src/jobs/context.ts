import { randomUUID } from "node:crypto";
import { runWithContext } from "../platform/request-context.js";

// Review D3: a job runs outside any HTTP request. Giving each run its own ID
// ("job:<name>:<uuid>") ties its audit rows, journal entries and log lines
// together, like a request ID does for API calls.
export function withJobContext<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ requestId: `job:${name}:${randomUUID()}` }, fn);
}
