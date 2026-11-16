import { describe, expect, it } from "vitest";
import live from "./fixtures/live-2026-11-16.json";
import { InvoiceService } from "../src/app.js";
import { verifyChain } from "../src/es/verify.js";
import { invoiceType } from "../src/es/verifactu.js";
import { toCents } from "../src/money.js";
import { fromGraphQL, type GraphQLOrder } from "../src/shopify/from-graphql.js";

// Real orders from the Shopify test store. Shopify's own totals are the truth.
const orders = (live.orders as GraphQLOrder[]).map((o) => ({ raw: o, order: fromGraphQL(o) }));
const shop = { seller: { name: "Tienda Prueba Einvoice SL", taxId: "A28015865" } };

describe("real orders from the Shopify test store", () => {
  it.each(orders.map((o) => [o.raw.name, o] as const))("%s: matches Shopify's total and VAT, or is held", async (name, { raw, order }) => {
    const app = new InvoiceService(shop, undefined, () => new Date("2026-11-16T16:00:00Z"));
    const out = await app.onOrder(order);
    if (name === "#1002") {
      // €3,799.80 with no customer tax ID can't be a simplified invoice.
      expect("held" in out && out.issues.map((i) => i.code)).toContain("simplified-limit");
      expect(app.ledger).toHaveLength(0);
      return;
    }
    expect("held" in out).toBe(false);
    if ("held" in out) return;
    expect(out.totals.total).toBe(toCents(raw.totalPriceSet.shopMoney.amount));
    expect(out.totals.tax).toBe(toCents(raw.totalTaxSet!.shopMoney.amount));
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(invoiceType(out.invoice)).toBe(name === "#1003" ? "F1" : "F2");
    expect(await verifyChain(app.ledger)).toEqual({ ok: true });
  });
});

describe("real refunds from the Shopify test store", () => {
  const refunded = orders.filter((o) => o.order.refunds!.length > 0);

  it.each(refunded.map((o) => [o.raw.name, o] as const))("%s: every credit note matches what Shopify refunded", async (_name, { raw, order }) => {
    const app = new InvoiceService(shop, undefined, () => new Date("2026-11-16T17:00:00Z"));
    await app.onOrder(order);
    for (const [i, refund] of order.refunds!.entries()) {
      const r = raw.refunds![i]!;
      const out = await app.onRefund({ ...order, refunds: order.refunds!.slice(0, i + 1) }, refund);
      expect("held" in out || "skipped" in out).toBe(false);
      if ("held" in out || "skipped" in out) return;
      const shopifyAmount = r.refundLineItems.nodes.reduce((s, x) => s + toCents(x.subtotalSet.shopMoney.amount), 0);
      const shopifyTax = r.refundLineItems.nodes.reduce((s, x) => s + toCents(x.totalTaxSet.shopMoney.amount), 0);
      expect(out.totals.total).toBe(-shopifyAmount);
      expect(out.totals.tax).toBe(-shopifyTax);
      expect(out.issues.filter((x) => x.level === "error")).toEqual([]);
    }
    expect(await verifyChain(app.ledger)).toEqual({ ok: true });
  });

  it("#1001: three refunds of one unit add up to exactly the line", async () => {
    const { order } = orders.find((o) => o.raw.name === "#1001")!;
    const app = new InvoiceService(shop, undefined, () => new Date("2026-11-16T17:00:00Z"));
    const inv = await app.onOrder(order);
    let total = 0, tax = 0;
    for (const [i, refund] of order.refunds!.entries()) {
      const out = await app.onRefund({ ...order, refunds: order.refunds!.slice(0, i + 1) }, refund);
      if ("totals" in out) { total += out.totals.total; tax += out.totals.tax; }
    }
    expect([total, tax]).toEqual([-2985, -518]); // 3 × 9.95, and the line's 5.18 VAT
    expect("held" in inv).toBe(false);
  });
});
