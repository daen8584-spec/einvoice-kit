import { describe, expect, it } from "vitest";
import order from "./fixtures/order-es.json";
import { InvoiceService } from "../src/app.js";
import { verifyChain } from "../src/es/verify.js";
import type { ShopifyOrder } from "../src/shopify/types.js";

const o = order as ShopifyOrder;
const shop = { seller: { name: "Tienda Ejemplo SL", taxId: "A28015865" } };
const at = (iso: string) => () => new Date(iso);

describe("the app's notification handling", () => {
  it("issues one invoice however many times Shopify sends the order", async () => {
    const app = new InvoiceService(shop, undefined, at("2026-04-01T09:00:00Z"));
    const results = await Promise.all([app.onOrder(o), app.onOrder(o), app.onOrder(o)]);
    expect(new Set(results)).toHaveProperty("size", 1);
    expect(app.documents.size).toBe(1);
    expect(app.ledger).toHaveLength(1);
  });

  it("doesn't lose a correction that arrives while an older copy of the order is being handled", async () => {
    // Found by the store simulation (seed 11): a refund carrying the order without
    // a tax ID, and the corrected order, in the same moment.
    const app = new InvoiceService(shop, undefined, at("2026-04-02T09:00:00Z"));
    const typo = { ...o, note_attributes: [{ name: "NIF", value: "B12345675" }] };
    await app.onOrder(typo);
    await Promise.all([app.onRefund(typo, o.refunds![0]!), app.onOrder(o)]);
    expect([...app.documents.values()].map((d) => d.invoice.number).sort()).toEqual(["F2026-000001", "R2026-000001"]);
    expect(app.held.size).toBe(0);
  });

  it("holds an invoice with a mistyped tax ID, using no number, and issues it once fixed", async () => {
    const app = new InvoiceService(shop, undefined, at("2026-04-02T09:00:00Z"));
    const typo = { ...o, note_attributes: [{ name: "NIF", value: "B12345675" }] };
    const first = await app.onOrder(typo);
    expect("held" in first && first.issues.map((i) => i.code)).toEqual(["buyer-nif"]);
    expect(app.ledger).toHaveLength(0);

    // A refund before the fix waits too.
    const refund = await app.onRefund(typo, o.refunds![0]!);
    expect("held" in refund).toBe(true);

    // Shopify sends "order updated" with the right tax ID: both go out, in order.
    const fixed = await app.onOrder(o);
    expect("held" in fixed).toBe(false);
    expect([...app.documents.values()].map((d) => d.invoice.number)).toEqual(["F2026-000001", "R2026-000001"]);
    expect(app.held.size).toBe(0);
    expect(await verifyChain(app.ledger)).toEqual({ ok: true });
  });
});
