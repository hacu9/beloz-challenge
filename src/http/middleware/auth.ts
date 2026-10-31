import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";
import type { Clock } from "../../platform/clock.js";
import { forbidden, unauthorized } from "../../platform/errors.js";

export type UserRole = "customer" | "ops";

export type Principal =
  | { type: "customer"; id: string }
  | { type: "ops"; id: string }
  | { type: "network" }
  | { type: "bank" };

export const JWT_ISSUER = "fake-login";
export const JWT_AUDIENCE = "acme-card";

const ClaimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(["customer", "ops"]),
});

// SEC-01: customer and ops calls carry a JWT with a role. Only HS256 is
// accepted, so a token with alg "none" or an asymmetric alg fails.
export function requireUser(
  roles: readonly UserRole[],
  opts: { secret: string; clock: Clock },
): RequestHandler {
  const key = new TextEncoder().encode(opts.secret);
  return async (req, _res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) throw unauthorized("a bearer token is required");

    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(match[1]!, key, {
        algorithms: ["HS256"],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        requiredClaims: ["exp", "sub"],
        currentDate: opts.clock.now(),
      }));
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) throw unauthorized("invalid or expired token");
      throw err;
    }
    const claims = ClaimsSchema.safeParse(payload);
    if (!claims.success) throw unauthorized("invalid token claims");
    if (!roles.includes(claims.data.role)) throw forbidden("role not allowed for this endpoint");

    req.principal = { type: claims.data.role, id: claims.data.sub };
    next();
  };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

// SEC-03: the card network authenticates with its API key. Both sides are
// hashed first, so the compare is constant-time whatever the input length.
export function requireNetworkKey(opts: { apiKey: string }): RequestHandler {
  const expected = sha256(opts.apiKey);
  return (req, _res, next) => {
    const provided = req.get("x-network-key");
    if (!provided || !safeEqual(sha256(provided), expected)) {
      throw unauthorized("invalid network key");
    }
    req.principal = { type: "network" };
    next();
  };
}

export const BANK_SIGNATURE_HEADER = "x-bank-signature";

export function bankSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

// SEC-04: the bank signs "<unix ts>.<raw body>" with HMAC-SHA256. A timestamp
// outside the tolerance window is rejected, which limits replay.
export function requireBankSignature(opts: {
  secret: string;
  clock: Clock;
  toleranceSeconds: number;
}): RequestHandler {
  return (req, _res, next) => {
    const header = req.get(BANK_SIGNATURE_HEADER) ?? "";
    const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
    if (!match) throw unauthorized("invalid bank signature");

    const timestamp = Number(match[1]);
    const nowSeconds = Math.floor(opts.clock.now().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > opts.toleranceSeconds) {
      throw unauthorized("bank signature timestamp outside the tolerance window");
    }
    // Fail closed: no raw JSON body means nothing was signed that the route
    // could act on (review C1). Never fall back to signing an empty body.
    if (!req.rawBody || req.rawBody.length === 0) {
      throw unauthorized("a signed JSON body is required");
    }
    const expected = bankSignature(opts.secret, timestamp, req.rawBody);
    if (!safeEqual(Buffer.from(match[2]!, "hex"), Buffer.from(expected, "hex"))) {
      throw unauthorized("invalid bank signature");
    }
    req.principal = { type: "bank" };
    next();
  };
}
