import { z } from "zod";

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().refine(Number.isSafeInteger).default(fallback);

const ConfigSchema = z.object({
  port: intFromEnv(3000),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  databaseUrl: z.string().url(),
  jwtSecret: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  networkApiKey: z.string().min(16, "NETWORK_API_KEY must be at least 16 characters"),
  bankWebhookSecret: z.string().min(32, "BANK_WEBHOOK_SECRET must be at least 32 characters"),
  bankSignatureToleranceSeconds: intFromEnv(300),
  holdTtlDays: intFromEnv(7),
  closingCaptureWindowDays: intFromEnv(30),
  minDepositCentavos: intFromEnv(50_000),
  maxAmountCentavos: intFromEnv(100_000_000),
  payoutStuckMinutes: intFromEnv(5),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    networkApiKey: env.NETWORK_API_KEY,
    bankWebhookSecret: env.BANK_WEBHOOK_SECRET,
    bankSignatureToleranceSeconds: env.BANK_SIGNATURE_TOLERANCE_SECONDS,
    holdTtlDays: env.HOLD_TTL_DAYS,
    closingCaptureWindowDays: env.CLOSING_CAPTURE_WINDOW_DAYS,
    minDepositCentavos: env.MIN_DEPOSIT_CENTAVOS,
    maxAmountCentavos: env.MAX_AMOUNT_CENTAVOS,
    payoutStuckMinutes: env.PAYOUT_STUCK_MINUTES,
  });
}
