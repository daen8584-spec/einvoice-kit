/**
 * A simulated Shopify store. It creates random orders and refunds in Shopify's
 * format and works out, with its own arithmetic, what every customer paid and
 * what every refund should give back. Nothing here uses the app's money code.
 */
import type { ShopifyOrder, ShopifyRefund } from "../../src/shopify/types.js";

export class Random {
  constructor(private seed: number) {}
  next(): number {
    // mulberry32
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
}

/** Exact rounding half away from zero with big integers: the auditor's own arithmetic. */
export function bigRound(numerator: bigint, denominator: bigint): bigint {
  const neg = numerator < 0n;
  const n = neg ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  const v = r * 2n >= denominator ? q + 1n : q;
  return neg ? -v : v;
}

const money = (c: bigint) => {
  const neg = c < 0n; const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
};

/** Madrid's UTC offset worked out from the EU rule, independently of Intl. */
export function madridDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, last.getUTCDate() - last.getUTCDay(), 1);
  };
  const summer = ms >= lastSunday(2) && ms < lastSunday(9);
  return new Date(ms + (summer ? 2 : 1) * 3600_000).toISOString().slice(0, 10);
}

const DNI = "TRWAGMYFPDXBNJZSQVHLCKE";
function makeTaxId(rnd: Random, valid: boolean): string {
  let id: string;
  if (rnd.chance(0.5)) {
    const n = rnd.int(0, 99_999_999);
    id = String(n).padStart(8, "0") + DNI[n % 23];
  } else {
    const digits = String(rnd.int(0, 9_999_999)).padStart(7, "0");
    let sum = 0;
    for (let i = 0; i < 7; i++) { const v = Number(digits[i]); sum += i % 2 ? v : Math.floor((v * 2) / 10) + ((v * 2) % 10); }
    id = `B${digits}${(10 - (sum % 10)) % 10}`;
  }
  if (valid) return id;
  const last = id.at(-1)!;
  const wrong = /\d/.test(last) ? String((Number(last) + 1) % 10) : DNI[(DNI.indexOf(last) + 1) % 23]!;
  return id.slice(0, -1) + wrong;
}

export interface SimLine {
  id: number; quantity: number; price: bigint; discount: bigint; rate: bigint; amount: bigint; tax: bigint;
}

export interface SimRefund {
  refund: ShopifyRefund;
  /** Order as Shopify sends it with this refund: every refund up to and including it. */
  orderAtRefund: ShopifyOrder;
  at: number;
  /** What the auditor expects back, per line: amount and tax, as positive cents. */
  expected: { amount: bigint; tax: bigint; units: number; byRate: Map<bigint, { amount: bigint; tax: bigint }> };
  overRefund: boolean;
}

export interface SimOrder {
  order: ShopifyOrder;
  at: number;
  lines: SimLine[];
  shipping: SimLine | null;
  charged: bigint;
  taxByRate: Map<bigint, bigint>;
  amountByRate: Map<bigint, bigint>;
  taxId: "none" | "valid" | "invalid";
  refunds: SimRefund[];
}

const RATES = [2100n, 2100n, 2100n, 1000n, 400n, 0n];
/** Times that tend to break date handling: daylight saving changes, midnight, new year. */
const HOTSPOTS = [
  Date.UTC(2026, 2, 29, 1, 0), Date.UTC(2026, 9, 25, 1, 0), Date.UTC(2026, 11, 31, 23, 0),
  Date.UTC(2026, 5, 30, 22, 0), Date.UTC(2026, 3, 30, 22, 0),
];

function lineTax(amount: bigint, rate: bigint, included: boolean): bigint {
  return included ? bigRound(amount * rate, 10000n + rate) : bigRound(amount * rate, 10000n);
}

export function makeOrder(rnd: Random, n: number): SimOrder {
  const included = rnd.chance(0.8);
  const at = rnd.chance(0.35)
    ? rnd.pick(HOTSPOTS) + rnd.int(-3 * 3600, 3 * 3600) * 1000
    : Date.UTC(2026, 2, 20) + rnd.int(0, 296 * 86400) * 1000;

  const lines: SimLine[] = Array.from({ length: rnd.int(1, 6) }, (_, i) => {
    const price = BigInt(rnd.chance(0.05) ? rnd.int(100_000, 900_000) : rnd.chance(0.3) ? rnd.int(1, 999) : rnd.int(100, 20_000));
    const quantity = rnd.chance(0.6) ? 1 : rnd.int(2, 12);
    return { id: n * 100 + i + 1, quantity, price, discount: 0n, rate: rnd.pick(RATES), amount: 0n, tax: 0n };
  });

  // An order-level discount code, split across lines in proportion like Shopify does.
  const subtotal = lines.reduce((s, l) => s + l.price * BigInt(l.quantity), 0n);
  if (rnd.chance(0.35) && subtotal > 0n) {
    const total = rnd.chance(0.5) ? (subtotal * BigInt(rnd.pick([5, 10, 15, 20, 33, 50]))) / 100n : BigInt(rnd.int(1, Number(subtotal)));
    let given = 0n;
    lines.forEach((l, i) => {
      const gross = l.price * BigInt(l.quantity);
      l.discount = i === lines.length - 1 ? total - given : (total * gross) / subtotal;
      given += l.discount;
    });
  }
  if (rnd.chance(0.15)) { const l = rnd.pick(lines); l.discount = l.price * BigInt(l.quantity); } // a free gift
  for (const l of lines) { l.amount = l.price * BigInt(l.quantity) - l.discount; l.tax = lineTax(l.amount, l.rate, included); }

  let shipping: SimLine | null = null;
  if (rnd.chance(0.7)) {
    const price = BigInt(rnd.pick([395, 495, 590, 990, rnd.int(1, 3000)]));
    const discount = rnd.chance(0.2) ? price : 0n;
    const rate = rnd.chance(0.9) ? 2100n : 0n;
    const amount = price - discount;
    shipping = { id: 0, quantity: 1, price, discount, rate, amount, tax: lineTax(amount, rate, included) };
  }

  const all = shipping && shipping.price > 0n ? [...lines, shipping] : lines;
  const taxByRate = new Map<bigint, bigint>();
  const amountByRate = new Map<bigint, bigint>();
  for (const l of all.filter((x) => x.quantity > 0)) {
    taxByRate.set(l.rate, (taxByRate.get(l.rate) ?? 0n) + l.tax);
    amountByRate.set(l.rate, (amountByRate.get(l.rate) ?? 0n) + l.amount);
  }
  const amounts = [...amountByRate.values()].reduce((a, b) => a + b, 0n);
  const taxes = [...taxByRate.values()].reduce((a, b) => a + b, 0n);
  const charged = included ? amounts : amounts + taxes;

  const taxId = rnd.chance(0.55) ? "none" : rnd.chance(0.9) ? "valid" : "invalid";
  const taxLines = (amount: bigint, tax: bigint, rate: bigint) =>
    rate === 0n ? [] : [{ title: "IVA", price: money(tax), rate: Number(rate) / 10000 }];

  const order: ShopifyOrder = {
    id: 7_000_000_000 + n,
    name: `#${1000 + n}`,
    created_at: new Date(at).toISOString(),
    processed_at: new Date(at).toISOString(),
    currency: "EUR",
    taxes_included: included,
    total_price: money(charged),
    line_items: lines.map((l) => ({
      id: l.id, title: `Producto ${l.id}`, variant_title: rnd.chance(0.4) ? "Talla M" : null, quantity: l.quantity, price: money(l.price),
      tax_lines: taxLines(l.amount, l.tax, l.rate),
      discount_allocations: l.discount ? [{ amount: money(l.discount) }] : [],
    })),
    shipping_lines: shipping
      ? [{ title: "Envío", price: money(shipping.price), tax_lines: taxLines(shipping.amount, shipping.tax, shipping.rate), discount_allocations: shipping.discount ? [{ amount: money(shipping.discount) }] : [] }]
      : [],
    billing_address: { name: "Cliente Prueba", company: rnd.chance(0.5) ? "Empresa Prueba SL" : null, address1: "Calle 1", city: "Madrid", zip: "28001", country_code: "ES" },
    note_attributes: taxId === "none" ? [] : [{ name: rnd.pick(["NIF", "nif", "CIF", "Tax ID", "NIF/CIF"]), value: makeTaxId(rnd, taxId === "valid") }],
    refunds: [],
  };

  const sim: SimOrder = { order, at, lines, shipping, charged, taxByRate, amountByRate, taxId, refunds: [] };
  addRefunds(rnd, sim);
  return sim;
}

/** Up to three refunds, each for some units, sometimes trying to refund more than is left. */
function addRefunds(rnd: Random, sim: SimOrder): void {
  if (!rnd.chance(0.3)) return;
  const refunded = new Map<number, number>();
  let at = sim.at;
  for (let k = 0; k < rnd.int(1, 3); k++) {
    at += rnd.int(3600, 20 * 86400) * 1000;
    const items: { line_item_id: number; quantity: number }[] = [];
    const byRate = new Map<bigint, { amount: bigint; tax: bigint }>();
    let amount = 0n, tax = 0n, units = 0, over = false;
    for (const l of sim.lines) {
      if (!rnd.chance(0.5)) continue;
      const before = refunded.get(l.id) ?? 0;
      const left = l.quantity - before;
      let ask = left > 0 ? rnd.int(1, left) : 0;
      if (rnd.chance(0.05)) { ask = left + rnd.int(1, 2); over = true; }
      if (ask <= 0) continue;
      const count = Math.min(ask, left);
      const q = BigInt(l.quantity), b = BigInt(before), c = BigInt(count);
      const a = bigRound(l.amount * (b + c), q) - bigRound(l.amount * b, q);
      const t = bigRound(l.tax * (b + c), q) - bigRound(l.tax * b, q);
      items.push({ line_item_id: l.id, quantity: ask });
      refunded.set(l.id, before + count);
      amount += a; tax += t; units += count;
      const g = byRate.get(l.rate) ?? { amount: 0n, tax: 0n };
      g.amount += a; g.tax += t; byRate.set(l.rate, g);
    }
    if (!items.length) continue;
    const refund: ShopifyRefund = { id: sim.order.id * 10 + k, created_at: new Date(at).toISOString(), note: rnd.chance(0.5) ? "Devolución" : null, refund_line_items: items, order_adjustments: [] };
    sim.order.refunds!.push(refund);
    sim.refunds.push({ refund, orderAtRefund: { ...sim.order, refunds: [...sim.order.refunds!] }, at, expected: { amount, tax, units, byRate }, overRefund: over });
  }
}
