import { describe, expect, it } from "vitest";
import {
  addCentavos,
  amountSchema,
  formatMxn,
  parsePgInteger,
  sumCentavos,
} from "../../src/platform/money.js";

describe("money", () => {
  const schema = amountSchema(100_000_000);

  it("MONEY-01: accepts a positive integer count of centavos", () => {
    expect(schema.parse(12_345)).toBe(12_345);
  });

  it("MONEY-02: rejects decimals, strings, zero, negatives and unsafe integers", () => {
    for (const bad of [10.5, "100", 0, -1, Number.NaN, Infinity, 2 ** 53]) {
      expect(schema.safeParse(bad).success, `value ${String(bad)}`).toBe(false);
    }
  });

  it("MONEY-05: rejects an amount above the configured maximum", () => {
    expect(schema.safeParse(100_000_000).success).toBe(true);
    expect(schema.safeParse(100_000_001).success).toBe(false);
  });

  it("MONEY-03: arithmetic throws instead of losing precision", () => {
    expect(addCentavos(1, 2)).toBe(3);
    expect(() => addCentavos(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(() => addCentavos(0.1, 0.2)).toThrow(RangeError);
    expect(sumCentavos([100, -40, -60])).toBe(0);
  });

  it("MONEY-04: parses Postgres integers exactly and refuses unsafe ones", () => {
    expect(parsePgInteger("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsePgInteger("-42")).toBe(-42);
    expect(() => parsePgInteger("9007199254740992")).toThrow(RangeError);
    expect(() => parsePgInteger("1.5")).toThrow(RangeError);
  });

  it("formats centavos for display without floats", () => {
    expect(formatMxn(123_456)).toBe("1234.56");
    expect(formatMxn(5)).toBe("0.05");
    expect(formatMxn(-250)).toBe("-2.50");
  });
});
