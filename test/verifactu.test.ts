import { describe, expect, it } from "vitest";
import type { Invoice } from "../src/invoice.js";
import { RecordChain, fingerprint, invoiceType, qrUrl, timestampWithOffset } from "../src/es/verifactu.js";

// The three worked examples in AEAT's technical specification for the Verifactu hash.
const FIRST = "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60";
const SECOND = "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97";
const CANCELLED = "177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68";

const base = { IDEmisorFactura: "89890001K", FechaExpedicionFactura: "01-01-2024", TipoFactura: "F1" as const, CuotaTotal: "12.35", ImporteTotal: "123.45" };

describe("Verifactu fingerprint", () => {
  it("matches AEAT's published examples", async () => {
    expect(await fingerprint({ ...base, NumSerieFactura: "12345678/G33", Huella: "", FechaHoraHusoGenRegistro: "2024-01-01T19:20:30+01:00" })).toBe(FIRST);
    expect(await fingerprint({ ...base, NumSerieFactura: "12345679/G34", Huella: FIRST, FechaHoraHusoGenRegistro: "2024-01-01T19:20:35+01:00" })).toBe(SECOND);
    expect(
      await fingerprint({
        IDEmisorFacturaAnulada: "89890001K",
        NumSerieFacturaAnulada: "12345679/G34",
        FechaExpedicionFacturaAnulada: "01-01-2024",
        Huella: SECOND,
        FechaHoraHusoGenRegistro: "2024-01-01T19:20:40+01:00",
      }),
    ).toBe(CANCELLED);
  });

  it("chains real invoices the same way", async () => {
    const invoice = (number: string): Invoice => ({
      kind: "invoice", number, issueDate: "2024-01-01", currency: "EUR", pricesIncludeTax: false,
      seller: { name: "Test", taxId: "89890001K" },
      buyer: { name: "Cliente", taxId: "12345678Z" },
      // 111.10 at 11.12% VAT gives the specification's tax of 12.35 and total of 123.45.
      lines: [{ description: "x", quantity: 1, unitPrice: 11110, rate: 1112 }],
    });
    const chain = new RecordChain();
    const a = await chain.register(invoice("12345678/G33"), new Date("2024-01-01T18:20:30Z"));
    const b = await chain.register(invoice("12345679/G34"), new Date("2024-01-01T18:20:35Z"));
    const c = await chain.cancel(invoice("12345679/G34"), new Date("2024-01-01T18:20:40Z"));
    expect([a.fingerprint, b.fingerprint, c.fingerprint]).toEqual([FIRST, SECOND, CANCELLED]);
  });

  it("writes Spanish local time with the right offset in winter and summer", () => {
    expect(timestampWithOffset(new Date("2024-01-01T18:20:30Z"))).toBe("2024-01-01T19:20:30+01:00");
    expect(timestampWithOffset(new Date("2026-07-15T08:00:00Z"))).toBe("2026-07-15T10:00:00+02:00");
    expect(timestampWithOffset(new Date("2026-07-15T08:00:00Z"), "Atlantic/Canary")).toBe("2026-07-15T09:00:00+01:00");
  });
});

describe("invoice type and QR", () => {
  const inv: Invoice = {
    kind: "invoice", number: "F2026-000001", issueDate: "2026-04-01", currency: "EUR", pricesIncludeTax: true,
    seller: { name: "Tienda", taxId: "B12345674" },
    lines: [{ description: "x", quantity: 1, unitPrice: 6885, rate: 2100 }],
  };

  it("is simplified without a buyer tax ID and full with one", () => {
    expect(invoiceType(inv)).toBe("F2");
    expect(invoiceType({ ...inv, buyer: { name: "C", taxId: "12345678Z" } })).toBe("F1");
    expect(invoiceType({ ...inv, kind: "credit-note" })).toBe("R5");
  });

  it("builds the AEAT verification link", () => {
    expect(qrUrl(inv, "test")).toBe(
      "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=F2026-000001&fecha=01-04-2026&importe=68.85",
    );
  });
});
