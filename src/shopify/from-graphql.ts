import type { ShopifyOrder } from "./types.js";

/**
 * Orders read through the Admin GraphQL API use different field names from the
 * webhook payloads. This turns one into the other, so both paths share the same
 * invoicing code.
 */

type Money = { shopMoney: { amount: string } };
type TaxLine = { title: string; rate: number; priceSet: Money };
type Allocation = { allocatedAmountSet: Money };

export interface GraphQLOrder {
  id?: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  currencyCode: string;
  taxesIncluded: boolean;
  totalPriceSet: Money;
  totalTaxSet?: Money;
  customAttributes?: { key: string; value: string | null }[];
  billingAddress?: { name?: string | null; company?: string | null; address1?: string | null; city?: string | null; zip?: string | null; countryCodeV2?: string | null } | null;
  lineItems: { nodes: { id: string; title: string; variantTitle?: string | null; quantity: number; originalUnitPriceSet: Money; discountAllocations: Allocation[]; taxLines: TaxLine[] }[] };
  refunds?: {
    legacyResourceId: string;
    createdAt: string;
    note?: string | null;
    refundLineItems: { nodes: { quantity: number; lineItem: { id: string }; subtotalSet: Money; totalTaxSet: Money }[] };
    orderAdjustments?: { nodes: { reason?: string | null; amountSet: Money; taxAmountSet: Money }[] };
  }[];
  shippingLines?: { nodes: { title: string; originalPriceSet: Money; discountAllocations: Allocation[]; taxLines: TaxLine[] }[] };
}

const numericId = (gid: string) => Number(gid.split("/").pop());
const tax = (t: TaxLine) => ({ title: t.title, rate: t.rate, price: t.priceSet.shopMoney.amount });
const discounts = (a: Allocation[]) => a.map((d) => ({ amount: d.allocatedAmountSet.shopMoney.amount }));

export function fromGraphQL(o: GraphQLOrder): ShopifyOrder {
  const b = o.billingAddress;
  return {
    id: Number(o.legacyResourceId),
    name: o.name,
    created_at: o.createdAt,
    processed_at: o.processedAt ?? null,
    currency: o.currencyCode,
    taxes_included: o.taxesIncluded,
    total_price: o.totalPriceSet.shopMoney.amount,
    line_items: o.lineItems.nodes.map((l) => ({
      id: numericId(l.id),
      title: l.title,
      variant_title: l.variantTitle ?? null,
      quantity: l.quantity,
      price: l.originalUnitPriceSet.shopMoney.amount,
      tax_lines: l.taxLines.map(tax),
      discount_allocations: discounts(l.discountAllocations),
    })),
    shipping_lines: (o.shippingLines?.nodes ?? []).map((s) => ({
      title: s.title,
      price: s.originalPriceSet.shopMoney.amount,
      tax_lines: s.taxLines.map(tax),
      discount_allocations: discounts(s.discountAllocations),
    })),
    billing_address: b ? { name: b.name ?? null, company: b.company ?? null, address1: b.address1 ?? null, city: b.city ?? null, zip: b.zip ?? null, country_code: b.countryCodeV2 ?? null } : null,
    note_attributes: (o.customAttributes ?? []).map((a) => ({ name: a.key, value: a.value ?? "" })),
    refunds: (o.refunds ?? [])
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({
        id: Number(r.legacyResourceId),
        created_at: r.createdAt,
        note: r.note ?? null,
        refund_line_items: r.refundLineItems.nodes.map((x) => ({
          line_item_id: numericId(x.lineItem.id),
          quantity: x.quantity,
          subtotal: x.subtotalSet.shopMoney.amount,
          total_tax: x.totalTaxSet.shopMoney.amount,
        })),
        order_adjustments: (r.orderAdjustments?.nodes ?? []).map((a) => ({
          kind: a.reason ?? "adjustment",
          amount: a.amountSet.shopMoney.amount,
          tax_amount: a.taxAmountSet.shopMoney.amount,
        })),
      })),
  };
}
