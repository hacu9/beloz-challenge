import type { Principal } from "./middleware/auth.js";
import type { IdempotencyScope } from "./middleware/idempotency.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      rawBody?: Buffer;
      principal?: Principal;
      idempotency?: IdempotencyScope;
    }
  }
}

export {};
