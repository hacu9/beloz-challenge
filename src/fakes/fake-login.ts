import { SignJWT } from "jose";
import type { Clock } from "../platform/clock.js";
import { JWT_AUDIENCE, JWT_ISSUER, type UserRole } from "../http/middleware/auth.js";

// Simulated login provider (Q5). Acme does not own login; this issues the test
// JWTs a real identity provider would issue.
export async function issueToken(
  opts: { sub: string; role: UserRole; ttlSeconds?: number; alg?: string },
  secret: string,
  clock: Clock,
): Promise<string> {
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ role: opts.role })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setSubject(opts.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (opts.ttlSeconds ?? 3600))
    .sign(new TextEncoder().encode(secret));
}
