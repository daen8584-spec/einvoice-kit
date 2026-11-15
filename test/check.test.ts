import { describe, expect, it } from "vitest";
import type { Invoice } from "../src/invoice.js";
import { checkSpanishInvoice } from "../src/es/check.js";

const good: Invoice = {
  kind: "invoice", number: "F2026-000001", issueDate: "2026-04-01", currency: "EUR", pricesIncludeTax: true,
  seller: { name: "Tienda Ejemplo SL", taxId: "B12345674" },
  lines: [{ description: "Camiseta", quantity: 2, unitPrice: 2500, rate: 2100 }],
};
const codes = (inv: Invoice, opts = {}) => checkSpanishInvoice(inv, { today: "2026-11-15", ...opts }).issues.map((i) => `${i.level}:${i.code}`);

describe("Spanish invoice checks", () => {
  it("finds nothing wrong with a correct simplified invoice", () => {
    expect(codes(good)).toEqual([]);
  });

  it("catches a mistyped seller NIF", () => {
    expect(codes({ ...good, seller: { name: "Tienda", taxId: "B12345675" } })).toEqual(["error:seller-nif"]);
  });

  it("warns above €400 and refuses above €3,000 without the customer's details", () => {
    expect(codes({ ...good, lines: [{ description: "x", quantity: 1, unitPrice: 50000, rate: 2100 }] })).toEqual(["warning:simplified-limit"]);
    expect(codes({ ...good, lines: [{ description: "x", quantity: 1, unitPrice: 350000, rate: 2100 }] })).toEqual(["error:simplified-limit"]);
    expect(codes({ ...good, buyer: { name: "Cliente SL", taxId: "A28015865" }, lines: [{ description: "x", quantity: 1, unitPrice: 350000, rate: 2100 }] })).toEqual([]);
  });

  it("requires a reason when there's no VAT", () => {
    expect(codes({ ...good, lines: [{ description: "Curso", quantity: 1, unitPrice: 10000, rate: 0 }] })).toEqual(["error:line-exemption"]);
    expect(codes({ ...good, lines: [{ description: "Curso", quantity: 1, unitPrice: 10000, rate: 0, exemption: "Art. 20.Uno.9 LIVA" }] })).toEqual([]);
  });

  it("requires credit notes to point at the original invoice", () => {
    expect(codes({ ...good, kind: "credit-note", lines: [{ description: "x", quantity: -1, unitPrice: 2500, rate: 2100 }] })).toEqual(["error:corrects", "warning:corrects-reason"]);
  });

  it("refuses negative lines on a normal invoice, future dates and unusual rates", () => {
    expect(codes({ ...good, issueDate: "2027-01-01", lines: [{ description: "x", quantity: -1, unitPrice: 100, rate: 1600 }] })).toEqual([
      "error:date", "warning:line-rate", "error:line-negative",
    ]);
  });

  it("compares the total printed on the invoice with the real one", () => {
    expect(codes(good, { statedTotal: 5000 })).toEqual([]);
    const issues = checkSpanishInvoice(good, { statedTotal: 4999, today: "2026-11-15" }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.en).toContain("49.99");
    expect(issues[0]!.es).toContain("50,00");
  });
});
