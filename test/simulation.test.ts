import { describe, expect, it } from "vitest";
import { runSimulation } from "./sim/run.js";

describe("simulated store", () => {
  it("issues the right invoice and credit note for every order and refund", async () => {
    const report = await runSimulation(3000, 2026);
    expect(report.failures).toEqual([]);
    expect(report.documents).toBe(report.orders + report.refunds);
    expect(report.deliveries).toBeGreaterThan(report.documents);
  }, 120_000);
});
