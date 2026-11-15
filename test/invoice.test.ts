import { describe, expect, it } from "vitest";
import { computeTotals, lineAmount, type InvoiceLine } from "../src/invoice.js";

describe("computeTotals", () => {
  it("adds tax on top when prices exclude it", () => {
    const t = computeTotals({
      pricesIncludeTax: false,
      lines: [
        { description: "a", quantity: 3, unitPrice: 1000, rate: 2100 },
        { description: "b", quantity: 1, unitPrice: 999, rate: 2100, discount: 99 },
        { description: "c", quantity: 2, unitPrice: 450, rate: 400 },
      ],
    });
    expect(t.groups).toEqual([
      { rate: 2100, base: 3900, tax: 819 },
      { rate: 400, base: 900, tax: 36 },
    ]);
    expect(t.total).toBe(3900 + 819 + 900 + 36);
  });

  it("takes tax out when prices include it, so the total is what the customer paid", () => {
    const t = computeTotals({ pricesIncludeTax: true, lines: [{ description: "a", quantity: 1, unitPrice: 1000, rate: 2100 }] });
    expect(t.groups).toEqual([{ rate: 2100, base: 826, tax: 174 }]);
    expect(t.total).toBe(1000);
  });

  it("never loses a cent with tax-inclusive prices, for any mix of lines", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const rates = [2100, 1000, 400, 0];
    for (let run = 0; run < 500; run++) {
      const lines: InvoiceLine[] = Array.from({ length: 1 + rand(8) }, () => ({
        description: "x",
        quantity: 1 + rand(5),
        unitPrice: 1 + rand(50000),
        rate: rates[rand(4)]!,
      }));
      const paid = lines.reduce((s, l) => s + lineAmount(l), 0);
      const t = computeTotals({ pricesIncludeTax: true, lines });
      expect(t.total).toBe(paid);
      for (const g of t.groups) expect(g.base + g.tax).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles credit notes with negative lines", () => {
    const t = computeTotals({ pricesIncludeTax: true, lines: [{ description: "a", quantity: -1, unitPrice: 2250, rate: 2100 }] });
    expect(t).toMatchObject({ base: -1860, tax: -390, total: -2250 });
  });
});
