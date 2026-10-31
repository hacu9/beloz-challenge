import { z } from "zod";

// MONEY-01: every amount is an integer count of MXN centavos.
// A JS number holds integers exactly up to 2^53 - 1 (about 90 trillion MXN),
// so every helper here rejects a value outside the safe-integer range.
export type Centavos = number;

export function isCentavos(value: unknown): value is Centavos {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function assertCentavos(value: unknown, label = "amount"): Centavos {
  if (!isCentavos(value)) {
    throw new RangeError(`${label} must be a safe integer of centavos, got ${String(value)}`);
  }
  return value;
}

export function addCentavos(a: Centavos, b: Centavos): Centavos {
  return assertCentavos(assertCentavos(a) + assertCentavos(b), "sum");
}

export function sumCentavos(values: readonly Centavos[]): Centavos {
  return values.reduce<Centavos>((acc, v) => addCentavos(acc, v), 0);
}

// MONEY-02, MONEY-05: the input schema for an amount at an HTTP boundary.
// z.number() rejects JSON strings; .int() rejects decimals; .refine catches
// integers that JSON.parse already rounded (above 2^53).
export function amountSchema(maxCentavos: Centavos) {
  return z
    .number()
    .int()
    .positive()
    .max(maxCentavos)
    .refine((v) => Number.isSafeInteger(v), "amount must be a safe integer");
}

// MONEY-04: Postgres returns int8 (and the numeric result of sum(int8)) as text.
// Parse it exactly; throw rather than round.
export function parsePgInteger(text: string): number {
  if (!/^-?\d+$/.test(text)) {
    throw new RangeError(`expected an integer from Postgres, got "${text}"`);
  }
  const big = BigInt(text);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`integer ${text} is outside the safe range`);
  }
  return Number(big);
}

/** Formats centavos as "1234.56" for display only. Never parse this back. */
export function formatMxn(amount: Centavos): string {
  assertCentavos(amount);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const pesos = Math.trunc(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${pesos}.${cents}`;
}
