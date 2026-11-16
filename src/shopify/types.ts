/**
 * The parts of Shopify's Order resource (Admin REST API) this project reads.
 * Shopify sends money as decimal strings and tax rates as fractions (0.21).
 */

export interface ShopifyTaxLine {
  title: string;
  price: string;
  rate: number;
}

export interface ShopifyDiscountAllocation {
  amount: string;
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  variant_title?: string | null;
  quantity: number;
  price: string;
  tax_lines: ShopifyTaxLine[];
  discount_allocations?: ShopifyDiscountAllocation[];
}

export interface ShopifyShippingLine {
  title: string;
  price: string;
  tax_lines: ShopifyTaxLine[];
  discount_allocations?: ShopifyDiscountAllocation[];
}

export interface ShopifyAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  city?: string | null;
  zip?: string | null;
  country_code?: string | null;
}

export interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  /** What Shopify refunded for these units, on the same basis as the price (VAT included when prices include it). */
  subtotal?: string;
  /** The VAT Shopify refunded for these units. */
  total_tax?: string;
}

export interface ShopifyOrderAdjustment {
  kind: string;
  amount: string;
  tax_amount: string;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  note?: string | null;
  refund_line_items: ShopifyRefundLineItem[];
  order_adjustments?: ShopifyOrderAdjustment[];
}

export interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at?: string | null;
  currency: string;
  taxes_included: boolean;
  total_price: string;
  line_items: ShopifyLineItem[];
  shipping_lines?: ShopifyShippingLine[];
  billing_address?: ShopifyAddress | null;
  note_attributes?: { name: string; value: string }[];
  refunds?: ShopifyRefund[];
}
