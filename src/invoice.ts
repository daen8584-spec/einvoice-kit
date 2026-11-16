import { roundDiv, type BasisPoints, type Cents } from "./money.js";

export interface Address {
  line1?: string;
  city?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, for example "ES". */
  country?: string;
}

export interface Party {
  name: string;
  taxId?: string;
  address?: Address;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** Price of one unit, including tax when the invoice's prices include tax. */
  unitPrice: Cents;
  /** Discount on the whole line, on the same basis as the price. */
  discount?: Cents;
  rate: BasisPoints;
  /**
   * The tax actually charged on this line, when the shop already worked it out
   * (Shopify does). Using it keeps the invoice equal to what the customer paid.
   */
  tax?: Cents;
  /** Required by most tax systems when the rate is 0: why no tax applies. */
  exemption?: string;
}

export interface CorrectedInvoice {
  number: string;
  issueDate: string;
  reason: string;
}

export interface Invoice {
  kind: "invoice" | "credit-note";
  number: string;
  /** YYYY-MM-DD: the day the invoice is issued. */
  issueDate: string;
  /** YYYY-MM-DD: the day of the sale, when it's earlier than the issue date. */
  operationDate?: string;
  seller: Party;
  buyer?: Party;
  currency: string;
  /** True for most EU shops, where shown prices already include VAT. */
  pricesIncludeTax: boolean;
  lines: InvoiceLine[];
  /** Credit notes must point at the invoice they correct. */
  corrects?: CorrectedInvoice;
  /** Where the invoice came from, for example a Shopify order name. */
  reference?: string;
}

export interface TaxGroup {
  rate: BasisPoints;
  base: Cents;
  tax: Cents;
}

export interface Totals {
  groups: TaxGroup[];
  base: Cents;
  tax: Cents;
  total: Cents;
}

export function lineAmount(line: InvoiceLine): Cents {
  return Math.round(line.quantity * line.unitPrice) - (line.discount ?? 0);
}

/**
 * If the lines carry the tax the shop charged, that's used as is. Otherwise tax
 * is worked out once per rate, on the sum of that rate's lines, rather than
 * line by line. With tax-inclusive prices the tax is taken out of the sum, so the
 * invoice total always equals what the customer actually paid.
 */
export function computeTotals(invoice: Pick<Invoice, "lines" | "pricesIncludeTax">): Totals {
  const sums = new Map<BasisPoints, { amount: Cents; charged: Cents; allCharged: boolean }>();
  for (const line of invoice.lines) {
    const g = sums.get(line.rate) ?? { amount: 0, charged: 0, allCharged: true };
    g.amount += lineAmount(line);
    if (line.tax === undefined) g.allCharged = false;
    else g.charged += line.tax;
    sums.set(line.rate, g);
  }

  const groups = [...sums.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, { amount: sum, charged, allCharged }]): TaxGroup => {
      // When every line carries the tax the shop charged, that's the tax.
      if (allCharged) return invoice.pricesIncludeTax ? { rate, base: sum - charged, tax: charged } : { rate, base: sum, tax: charged };
      if (invoice.pricesIncludeTax) {
        const tax = roundDiv(sum * rate, 10000 + rate);
        return { rate, base: sum - tax, tax };
      }
      return { rate, base: sum, tax: roundDiv(sum * rate, 10000) };
    });

  const base = groups.reduce((s, g) => s + g.base, 0);
  const tax = groups.reduce((s, g) => s + g.tax, 0);
  return { groups, base, tax, total: base + tax };
}
