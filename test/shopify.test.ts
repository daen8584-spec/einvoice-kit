import { describe, expect, it } from "vitest";
import order from "./fixtures/order-es.json";
import { computeTotals } from "../src/invoice.js";
import { toCents } from "../src/money.js";
import { MemorySequenceStore, nextNumber } from "../src/numbering.js";
import { checkSpanishInvoice } from "../src/es/check.js";
import { invoiceType } from "../src/es/verifactu.js";
import { localDate, orderToInvoice, refundToCreditNote, type ShopSettings } from "../src/shopify/to-invoice.js";
import type { ShopifyOrder } from "../src/shopify/types.js";

const shop: ShopSettings = { seller: { name: "Tienda Ejemplo SL", taxId: "A28015865", address: { line1: "Gran Vía 1", city: "Madrid", postalCode: "28013", country: "ES" } } };
const o = order as ShopifyOrder;

describe("Shopify order to invoice", () => {
  const { invoice, warnings } = orderToInvoice(o, shop, "F2026-000001");
  const totals = computeTotals(invoice);

  it("matches exactly what the customer paid", () => {
    expect(totals.total).toBe(toCents(o.total_price));
    expect(totals.groups).toEqual([
      { rate: 2100, base: 4128, tax: 867 },
      { rate: 400, base: 1817, tax: 73 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("includes discounts and shipping as lines", () => {
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.discount ?? 0, l.rate])).toEqual([
      ["Camiseta de algodón (M / Azul)", 2, 2500, 500, 2100],
      ["Libro: Recetas de casa", 1, 1890, 0, 400],
      ["Envío estándar", 1, 495, 0, 2100],
    ]);
  });

  it("takes the customer's NIF from the checkout field, making it a full invoice", () => {
    expect(invoice.buyer).toMatchObject({ name: "Papelería Martín SL", taxId: "B12345674", address: { city: "Zaragoza" } });
    expect(invoiceType(invoice)).toBe("F1");
  });

  it("dates the invoice in Spanish time: 23:30 UTC on 31 March is 1 April in Madrid", () => {
    expect(invoice.issueDate).toBe("2026-04-01");
    expect(localDate("2026-03-31T23:30:00Z", "Atlantic/Canary")).toBe("2026-04-01");
    expect(localDate("2026-01-31T23:30:00Z", "Atlantic/Canary")).toBe("2026-01-31");
  });

  it("passes the Spanish checks", () => {
    expect(checkSpanishInvoice(invoice, { today: "2026-11-15" }).issues).toEqual([]);
  });

  it("is a simplified invoice when the customer gives no NIF", () => {
    const { invoice: anon } = orderToInvoice({ ...o, note_attributes: [] }, shop, "F2026-000002");
    expect(anon.buyer).toBeUndefined();
    expect(invoiceType(anon)).toBe("F2");
  });

  it("warns when an untaxed line has no exemption text", () => {
    const untaxed = { ...o, line_items: [{ ...o.line_items[1]!, tax_lines: [] }], shipping_lines: [] };
    expect(orderToInvoice(untaxed, shop, "X").warnings).toHaveLength(1);
    expect(orderToInvoice(untaxed, { ...shop, exemptionText: "Art. 20 LIVA" }, "X").warnings).toEqual([]);
  });
});

describe("Shopify refund to credit note", () => {
  const { invoice: original } = orderToInvoice(o, shop, "F2026-000001");
  const { invoice: credit, warnings } = refundToCreditNote(o, o.refunds![0]!, original, shop, "R2026-000001");

  it("refunds one shirt at the discounted price actually paid", () => {
    expect(computeTotals(credit)).toMatchObject({ base: -1860, tax: -390, total: -2250 });
    expect(warnings).toEqual([]);
  });

  it("points at the original invoice and keeps the customer", () => {
    expect(credit.corrects).toEqual({ number: "F2026-000001", issueDate: "2026-04-01", reason: "Talla equivocada" });
    expect(credit.buyer?.taxId).toBe("B12345674");
    expect(invoiceType(credit)).toBe("R1");
    expect(checkSpanishInvoice(credit, { today: "2026-11-15" }).issues).toEqual([]);
  });

  it("asks for a look when the refund includes shipping or other adjustments", () => {
    const refund = { ...o.refunds![0]!, order_adjustments: [{ kind: "shipping_refund", amount: "-4.09", tax_amount: "-0.86" }] };
    expect(refundToCreditNote(o, refund, original, shop, "R2").warnings).toHaveLength(1);
  });
});

describe("duplicate webhooks", () => {
  it("issue one invoice number per order", async () => {
    const store = new MemorySequenceStore();
    const deliveries = await Promise.all([1, 2, 3].map(() => nextNumber(store, "F", "2026-04-01", `order:${o.id}`)));
    expect(new Set(deliveries)).toEqual(new Set(["F2026-000001"]));
  });
});
