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
    const app = new InvoiceService(shop, undefined, undefined, () => new Date("2026-11-16T16:00:00Z"));
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
