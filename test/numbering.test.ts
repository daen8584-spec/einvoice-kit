import { describe, expect, it } from "vitest";
import { MemorySequenceStore, nextNumber } from "../src/numbering.js";

describe("invoice numbers", () => {
  it("are consecutive within a series and restart each year", async () => {
    const store = new MemorySequenceStore();
    expect(await nextNumber(store, "F", "2026-01-02", "order-1")).toBe("F2026-000001");
    expect(await nextNumber(store, "F", "2026-01-02", "order-2")).toBe("F2026-000002");
    expect(await nextNumber(store, "R", "2026-01-03", "refund-1")).toBe("R2026-000001");
    expect(await nextNumber(store, "F", "2027-01-01", "order-3")).toBe("F2027-000001");
  });

  it("give the same order the same number when its webhook arrives twice", async () => {
    const store = new MemorySequenceStore();
    const first = await nextNumber(store, "F", "2026-05-01", "order-9");
    const again = await nextNumber(store, "F", "2026-05-01", "order-9");
    expect(again).toBe(first);
    expect(await nextNumber(store, "F", "2026-05-01", "order-10")).toBe("F2026-000002");
  });

  it("never hand out the same number twice when orders arrive at once", async () => {
    const store = new MemorySequenceStore();
    const numbers = await Promise.all(Array.from({ length: 200 }, (_, i) => nextNumber(store, "F", "2026-05-01", `o${i}`)));
    expect(new Set(numbers).size).toBe(200);
    expect(numbers.sort().at(-1)).toBe("F2026-000200");
  });
});
