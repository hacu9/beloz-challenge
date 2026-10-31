import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type pg from "pg";
import type { Clock } from "../../platform/clock.js";
import { withTx, type Tx } from "../../platform/db/tx.js";
import { badRequest, unprocessable } from "../../platform/errors.js";

export interface IdempotencyScope {
  /** Who owns the key, for example "customer:<uuid>". Keys never collide across callers. */
  caller: string;
  key: string;
  /** SHA-256 of method, path and raw body. */
  requestHash: string;
}

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

// IDEM-01: every customer/ops money or state call must carry Idempotency-Key.
// Mount after requireUser, so the key is scoped to the authenticated caller.
export function requireIdempotencyKey(): RequestHandler {
  return (req, _res, next) => {
    const key = req.get("idempotency-key");
    if (!key || !VALID_KEY.test(key)) {
      throw badRequest(
        "idempotency_key_required",
        "Idempotency-Key header is required (1-255 visible ASCII characters)",
      );
    }
    const p = req.principal;
    if (!p || (p.type !== "customer" && p.type !== "ops")) {
      throw new Error("requireIdempotencyKey must run after requireUser");
    }
    req.idempotency = {
      caller: `${p.type}:${p.id}`,
      key,
      requestHash: createHash("sha256")
        .update(`${req.method}\n${req.originalUrl}\n`)
        .update(req.rawBody ?? Buffer.alloc(0))
        .digest("hex"),
    };
    next();
  };
}

// IDEM-02..05. The key row is inserted first, inside the same transaction as
// the change. A parallel request with the same key blocks on the primary key
// until the first one commits, then reads the stored response. If the first
// one rolls back, its key row disappears with it, and the second one runs.
//
// A thrown error rolls everything back and stores nothing, so the client may
// retry with the same key. A business outcome that must replay (for example a
// decline) is returned as a StoredResponse, not thrown.
export async function runIdempotent(
  pool: pg.Pool,
  clock: Clock,
  scope: IdempotencyScope,
  fn: (tx: Tx) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  return withTx(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (caller, key, request_hash, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (caller, key) DO NOTHING`,
      [scope.caller, scope.key, scope.requestHash, clock.now()],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await tx.query<{
        request_hash: string;
        response_status: number;
        response_body: Record<string, unknown>;
      }>(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys WHERE caller = $1 AND key = $2`,
        [scope.caller, scope.key],
      );
      const row = rows[0];
      if (!row) throw new Error("idempotency key vanished after a conflict");
      if (row.request_hash !== scope.requestHash) {
        throw unprocessable(
          "idempotency_key_reused",
          "this Idempotency-Key was already used with a different request",
        );
      }
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    const result = await fn(tx);
    await tx.query(
      `UPDATE idempotency_keys
       SET response_status = $3, response_body = $4, completed_at = $5
       WHERE caller = $1 AND key = $2`,
      [scope.caller, scope.key, result.status, JSON.stringify(result.body), clock.now()],
    );
    return { ...result, replayed: false };
  });
}

/** Route helper: run the handler idempotently and send the (possibly replayed) response. */
export async function sendIdempotent(
  req: Request,
  res: Response,
  deps: { pool: pg.Pool; clock: Clock },
  fn: (tx: Tx) => Promise<StoredResponse>,
): Promise<void> {
  if (!req.idempotency) throw new Error("sendIdempotent needs requireIdempotencyKey");
  const result = await runIdempotent(deps.pool, deps.clock, req.idempotency, fn);
  if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(result.status).json(result.body);
}
