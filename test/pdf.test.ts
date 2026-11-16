import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import order from "./fixtures/order-es.json";
import { renderInvoicePdf } from "../src/pdf.js";
import { qrUrl } from "../src/es/verifactu.js";
import { orderToInvoice } from "../src/shopify/to-invoice.js";
import type { ShopifyOrder } from "../src/shopify/types.js";

const { invoice } = orderToInvoice(order as ShopifyOrder, { seller: { name: "Tienda Ejemplo SL", taxId: "A28015865" } }, "F2026-000001");

describe("invoice PDF", () => {
  it("renders a one-page PDF in Spanish and English", async () => {
    for (const lang of ["es", "en"] as const) {
      const bytes = await renderInvoicePdf(invoice, { lang, qr: qrUrl(invoice, "test") });
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getTitle()).toBe("F2026-000001");
    }
  });

  it("doesn't crash on characters the standard font can't draw", async () => {
    const odd = { ...invoice, lines: [{ ...invoice.lines[0]!, description: "Taza 😀 日本 ŁÓDŹ" }] };
    await expect(renderInvoicePdf(odd)).resolves.toBeInstanceOf(Uint8Array);
  });
});
