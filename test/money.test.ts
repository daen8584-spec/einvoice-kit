import { describe, expect, it } from "vitest";
import { formatPlain, roundDiv, toBasisPoints, toCents } from "../src/money.js";

describe("money", () => {
  it("parses amounts exactly", () => {
    expect(toCents("25.00")).toBe(2500);
    expect(toCents("18.9")).toBe(1890);
    expect(toCents("12,50")).toBe(1250);
    expect(toCents("-4.95")).toBe(-495);
    expect(toCents("0.105")).toBe(11);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(() => toCents("12.5€")).toThrow();
  });

  it("rounds half away from zero, also for negative amounts", () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(-4, 3)).toBe(-1);
  });

  it("formats for tax authorities", () => {
    expect(formatPlain(123456)).toBe("1234.56");
    expect(formatPlain(-5)).toBe("-0.05");
    expect(toBasisPoints(0.21)).toBe(2100);
    expect(toBasisPoints(0.055)).toBe(550);
  });
});
