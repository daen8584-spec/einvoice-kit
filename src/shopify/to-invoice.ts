import type { Invoice, InvoiceLine, Party } from "../invoice.js";
import { toBasisPoints, toCents } from "../money.js";
import type { ShopifyLineItem, ShopifyOrder, ShopifyRefund, ShopifyShippingLine, ShopifyTaxLine } from "./types.js";

export interface ShopSettings {
  seller: Party;
  /** Checkout fields where customers type their tax ID, matched case-insensitively. */
  taxIdFields?: string[];
  /** Printed on lines with no tax, for example "Exento por el art. 20 LIVA". */
  exemptionText?: string;
  /** Where the invoice date is taken from. */
  timeZone?: string;
}

export interface Conversion {
  invoice: Invoice;
  /** Things the store owner should look at; the invoice is still issued. */
  warnings: string[];
}

const DEFAULT_TAX_ID_FIELDS = ["nif", "cif", "nie", "dni", "tax id", "vat number", "nif/cif"];

/** The calendar date in the shop's time zone, so an order at 00:30 in Madrid isn't dated the day before. */
export function localDate(timestamp: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(timestamp))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function rateOf(taxLines: ShopifyTaxLine[]): number {
  return toBasisPoints(taxLines.reduce((sum, t) => sum + t.rate, 0));
}

function discountOf(allocations: { amount: string }[] | undefined): number {
  return (allocations ?? []).reduce((sum, a) => sum + toCents(a.amount), 0);
}

function itemLine(item: ShopifyLineItem, exemption: string | undefined): InvoiceLine {
  const line: InvoiceLine = {
    description: item.variant_title ? `${item.title} (${item.variant_title})` : item.title,
    quantity: item.quantity,
    unitPrice: toCents(item.price),
    rate: rateOf(item.tax_lines),
  };
  const discount = discountOf(item.discount_allocations);
  if (discount) line.discount = discount;
  if (line.rate === 0 && exemption) line.exemption = exemption;
  return line;
}

function shippingLine(s: ShopifyShippingLine, exemption: string | undefined): InvoiceLine {
  const line: InvoiceLine = { description: s.title, quantity: 1, unitPrice: toCents(s.price), rate: rateOf(s.tax_lines) };
  const discount = discountOf(s.discount_allocations);
  if (discount) line.discount = discount;
  if (line.rate === 0 && exemption) line.exemption = exemption;
  return line;
}

function buyerOf(order: ShopifyOrder, settings: ShopSettings): Party | undefined {
  const fields = (settings.taxIdFields ?? DEFAULT_TAX_ID_FIELDS).map((f) => f.toLowerCase());
  const taxId = order.note_attributes?.find((a) => fields.includes(a.name.trim().toLowerCase()))?.value.trim();
  const billing = order.billing_address;
  if (!taxId) return undefined;
  const buyer: Party = { name: billing?.company || billing?.name || "", taxId };
  const address = {
    ...(billing?.address1 ? { line1: billing.address1 } : {}),
    ...(billing?.city ? { city: billing.city } : {}),
    ...(billing?.zip ? { postalCode: billing.zip } : {}),
    ...(billing?.country_code ? { country: billing.country_code } : {}),
  };
  if (Object.keys(address).length) buyer.address = address;
  return buyer;
}

export function orderToInvoice(order: ShopifyOrder, settings: ShopSettings, number: string): Conversion {
  const warnings: string[] = [];
  const exemption = settings.exemptionText;
  const lines = [
    ...order.line_items.filter((i) => i.quantity > 0).map((i) => itemLine(i, exemption)),
    ...(order.shipping_lines ?? []).filter((s) => toCents(s.price) !== 0).map((s) => shippingLine(s, exemption)),
  ];
  if (lines.some((l) => l.rate === 0 && !l.exemption))
    warnings.push("Some lines have no tax and no exemption text. Set one in the app's settings.");

  const buyer = buyerOf(order, settings);
  const invoice: Invoice = {
    kind: "invoice",
    number,
    issueDate: localDate(order.processed_at ?? order.created_at, settings.timeZone ?? "Europe/Madrid"),
    seller: settings.seller,
    currency: order.currency,
    pricesIncludeTax: order.taxes_included,
    lines,
    reference: order.name,
    ...(buyer ? { buyer } : {}),
  };
  return { invoice, warnings };
}

/**
 * A refund becomes a credit note with negative lines, pointing at the original
 * invoice. Refunded items are priced as their share of the original line, so a
 * discount on the order is refunded in the same proportion.
 */
export function refundToCreditNote(
  order: ShopifyOrder,
  refund: ShopifyRefund,
  original: Pick<Invoice, "number" | "issueDate" | "buyer">,
  settings: ShopSettings,
  number: string,
): Conversion {
  const warnings: string[] = [];
  const byId = new Map(order.line_items.map((i) => [i.id, i]));
  const lines: InvoiceLine[] = [];

  for (const r of refund.refund_line_items) {
    const item = byId.get(r.line_item_id);
    if (!item) {
      warnings.push(`Refund ${refund.id} mentions line item ${r.line_item_id}, which isn't on order ${order.name}.`);
      continue;
    }
    const full = itemLine(item, settings.exemptionText);
    const gross = full.unitPrice * item.quantity - (full.discount ?? 0);
    const refunded = Math.round((gross * r.quantity) / item.quantity);
    lines.push({ ...full, quantity: -r.quantity, unitPrice: full.unitPrice, discount: -(full.unitPrice * r.quantity - refunded) });
  }
  if (refund.order_adjustments?.length)
    warnings.push(`Refund ${refund.id} includes a shipping refund or other adjustment. Check the credit note before sending it.`);

  const invoice: Invoice = {
    kind: "credit-note",
    number,
    issueDate: localDate(refund.created_at, settings.timeZone ?? "Europe/Madrid"),
    seller: settings.seller,
    currency: order.currency,
    pricesIncludeTax: order.taxes_included,
    lines,
    corrects: { number: original.number, issueDate: original.issueDate, reason: refund.note?.trim() || "Devolución" },
    reference: order.name,
    ...(original.buyer ? { buyer: original.buyer } : {}),
  };
  return { invoice, warnings };
}
