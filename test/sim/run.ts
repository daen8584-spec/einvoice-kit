/**
 * Runs the simulated store against the real app code and audits every document
 * with independent arithmetic. Returns every rule that was broken; an empty list
 * means every check passed for every order, refund and record.
 */
import { createHash } from "node:crypto";
import type { DocumentStore } from "../../src/store.js";
import { InvoiceService, type IssuedDocument } from "../../src/app.js";
import { verifyChain } from "../../src/es/verify.js";
import type { ChainedRecord } from "../../src/es/verifactu.js";
import type { ShopifyOrder } from "../../src/shopify/types.js";
import { makeOrder, madridDate, Random, type SimOrder, type SimRefund } from "./store.js";

export interface Report {
  orders: number; refunds: number; deliveries: number; documents: number; records: number;
  checks: number; failures: string[]; seconds: number;
  facts: Record<string, number>;
}

type Event = { at: number; kind: "order"; sim: SimOrder; order: ShopifyOrder } | { at: number; kind: "refund"; sim: SimOrder; refund: SimRefund };

const plain = (c: bigint) => { const n = c < 0n; const a = n ? -c : c; return `${n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`; };

/** `store` lets the same audit run against any storage, such as the SQLite database. */
export async function runSimulation(orderCount: number, seed = 1, store?: DocumentStore): Promise<Report> {
  const started = Date.now();
  const rnd = new Random(seed);
  const sims = Array.from({ length: orderCount }, (_, i) => makeOrder(rnd, i + 1));

  // Every notification arrives 1 to 3 times, a little late, in no particular order.
  const events: Event[] = [];
  for (const sim of sims) {
    for (let k = rnd.int(1, 3); k > 0; k--) events.push({ at: sim.at + rnd.int(0, 900) * 1000, kind: "order", sim, order: sim.order });
    if (sim.correction)
      for (let k = rnd.int(1, 2); k > 0; k--) events.push({ at: sim.correction.at + rnd.int(0, 900) * 1000, kind: "order", sim, order: sim.correction.order });
    for (const refund of sim.refunds)
      for (let k = rnd.int(1, 2); k > 0; k--) events.push({ at: refund.at + rnd.int(0, 900) * 1000, kind: "refund", sim, refund });
  }
  events.sort((a, b) => a.at - b.at);

  let now = 0;
  const service = new InvoiceService(
    { seller: { name: "Tienda Simulada SL", taxId: "A28015865" }, exemptionText: "Exento, art. 20 LIVA" },
    store, () => new Date(now),
  );

  // Notifications within the same minute are handled at the same time.
  for (let i = 0; i < events.length; ) {
    const batchStart = events[i]!.at;
    const batch: Event[] = [];
    while (i < events.length && events[i]!.at < batchStart + 60_000) batch.push(events[i++]!);
    now = batch.at(-1)!.at;
    // A refund can arrive before its order's own notification; the app must cope.
    await Promise.all(batch.map((e) => (e.kind === "order" ? service.onOrder(e.order) : service.onRefund(e.refund.orderAtRefund, e.refund.refund))));
  }

  const failures: string[] = [];
  let checks = 0;
  const expect = (ok: boolean, message: () => string) => { checks++; if (!ok && failures.length < 50) failures.push(message()); else if (!ok) failures.push(""); };
  const facts: Record<string, number> = {};
  const fact = (k: string) => { facts[k] = (facts[k] ?? 0) + 1; };

  const docs = service.documents;
  const heldDocs = service.held;
  const skippedDocs = service.skipped;
  for (const sim of sims) {
    const o = sim.order;
    const needsFix = sim.taxId === "invalid" || (sim.taxId === "none" && sim.charged > 300_000n);
    const doc = docs.get(`order:${o.id}`);

    if (needsFix && !sim.correction) {
      // Never fixed: nothing may be issued for this order, not even its refunds.
      const held = heldDocs.get(`order:${o.id}`);
      const codes = held ? held.issues.filter((x) => x.level === "error").map((x) => x.code) : [];
      const want = sim.taxId === "invalid" ? "buyer-nif" : "simplified-limit";
      expect(!doc && Boolean(held) && codes.includes(want), () => `${o.name}: should be held for ${want}, got ${doc ? "an issued invoice" : codes.join(",")}`);
      for (const r of sim.refunds)
        expect(!docs.has(`refund:${r.refund.id}`) && heldDocs.has(`refund:${r.refund.id}`), () => `${o.name}: refund ${r.refund.id} was issued for a held invoice`);
      fact(sim.taxId === "invalid" ? "held: mistyped tax ID, never fixed" : "held: over €3,000 without tax ID, never fixed");
      if (sim.refunds.length) fact("held: refunds waiting for a held invoice");
      continue;
    }

    expect(Boolean(doc), () => `${o.name}: no invoice was issued`);
    if (!doc) continue;
    if (needsFix) fact("held, then issued after the customer fixed it");
    const inv = doc.invoice;
    const t = doc.totals;
    fact(o.taxes_included ? "prices with VAT" : "prices without VAT");
    if (sim.lines.some((l) => l.discount > 0n)) fact("orders with discounts");

    expect(BigInt(t.total) === sim.charged, () => `${o.name}: invoice total ${t.total} but the customer paid ${sim.charged}`);
    for (const [rate, tax] of sim.taxByRate) {
      const g = t.groups.find((x) => BigInt(x.rate) === rate);
      const amount = sim.amountByRate.get(rate)!;
      const base = o.taxes_included ? amount - tax : amount;
      expect(g !== undefined && BigInt(g.tax) === tax && BigInt(g.base) === base, () => `${o.name}: VAT ${rate} should be base ${base} tax ${tax}, got ${JSON.stringify(g)}`);
    }
    expect(t.groups.length === sim.taxByRate.size, () => `${o.name}: unexpected VAT rates ${t.groups.map((g) => g.rate)}`);
    expect(t.groups.every((g) => g.base + g.tax >= 0), () => `${o.name}: negative amount on an invoice`);

    const f = doc.record.fields as unknown as Record<string, string>;
    const generated = Date.parse(f.FechaHoraHusoGenRegistro!);
    expect(inv.issueDate === madridDate(generated), () => `${o.name}: issue date ${inv.issueDate}, but it was generated on ${madridDate(generated)} in Madrid`);
    expect(generated >= sim.at, () => `${o.name}: invoice generated before the sale`);
    const sale = madridDate(sim.at);
    expect((inv.operationDate ?? inv.issueDate) === sale, () => `${o.name}: sale date ${inv.operationDate ?? inv.issueDate}, expected ${sale}`);
    if (inv.operationDate) fact("invoices issued on a later day than the sale");

    const full = sim.taxId === "valid" || needsFix;
    expect(f.ImporteTotal === plain(sim.charged), () => `${o.name}: Verifactu total ${f.ImporteTotal}`);
    expect(f.CuotaTotal === plain([...sim.taxByRate.values()].reduce((a, b) => a + b, 0n)), () => `${o.name}: Verifactu tax ${f.CuotaTotal}`);
    expect(f.TipoFactura === (full ? "F1" : "F2"), () => `${o.name}: type ${f.TipoFactura} with tax ID ${sim.taxId}`);
    expect(f.NumSerieFactura === inv.number && f.IDEmisorFactura === "A28015865", () => `${o.name}: Verifactu identity fields wrong`);
    const errors = doc.issues.filter((x) => x.level === "error").map((x) => x.code);
    expect(errors.length === 0, () => `${o.name}: issued with errors ${errors.join(",")}`);

    let refundedAll = 0n, refundedTax = 0n;
    for (const r of sim.refunds) {
      if (r.expected.units === 0) {
        const skipped = skippedDocs.get(`refund:${r.refund.id}`);
        expect(Boolean(skipped) && !docs.has(`refund:${r.refund.id}`), () => `${o.name}: refund ${r.refund.id} with nothing left should issue no credit note`);
        fact("refunds with nothing left, correctly skipped");
        continue;
      }
      const cn = docs.get(`refund:${r.refund.id}`);
      expect(Boolean(cn), () => `${o.name}: refund ${r.refund.id} has no credit note`);
      if (!cn) continue;
      fact("credit notes");
      if (r.overRefund) fact("refunds of more units than were left, capped");
      expect(cn.invoice.corrects?.number === inv.number && cn.invoice.corrects.issueDate === inv.issueDate, () => `${o.name}: credit note doesn't point at its invoice`);
      const exp = o.taxes_included ? r.expected.amount : r.expected.amount + r.expected.tax;
      expect(BigInt(cn.totals.total) === -exp, () => `${o.name}: refund ${r.refund.id} credits ${cn.totals.total}, expected ${-exp}`);
      expect(BigInt(cn.totals.tax) === -r.expected.tax, () => `${o.name}: refund ${r.refund.id} VAT ${cn.totals.tax}, expected ${-r.expected.tax}`);
      expect(r.overRefund === cn.warnings.some((w) => w.includes("left to refund")), () => `${o.name}: refund ${r.refund.id} over-refund warning wrong`);
      const cnErrors = cn.issues.filter((x) => x.level === "error").map((x) => x.code);
      expect(cnErrors.length === 0, () => `${o.name}: credit note issued with errors ${cnErrors.join(",")}`);
      const cf = cn.record.fields as unknown as Record<string, string>;
      expect(cf.TipoFactura === (full ? "R1" : "R5"), () => `${o.name}: credit note type ${cf.TipoFactura}`);
      expect(cn.invoice.issueDate === madridDate(Date.parse(cf.FechaHoraHusoGenRegistro!)) && cn.invoice.issueDate >= inv.issueDate, () => `${o.name}: credit note dated ${cn.invoice.issueDate}`);
      refundedAll += BigInt(cn.totals.total); refundedTax += BigInt(cn.totals.tax);
    }

    // A fully refunded order gives back exactly what was paid for the products.
    const unitsLeft = sim.lines.reduce((s, l) => {
      const back = sim.refunds.reduce((a, r) => a + Math.min(r.refund.refund_line_items.filter((x) => x.line_item_id === l.id).reduce((q, x) => q + x.quantity, 0), l.quantity), 0);
      return s + Math.max(0, l.quantity - back);
    }, 0);
    if (sim.refunds.length && unitsLeft === 0) {
      fact("orders refunded in full");
      const products = sim.lines.reduce((s, l) => s + (o.taxes_included ? l.amount : l.amount + l.tax), 0n);
      const productTax = sim.lines.reduce((s, l) => s + l.tax, 0n);
      expect(-refundedAll === products && -refundedTax === productTax, () => `${o.name}: refunded ${-refundedAll} (VAT ${-refundedTax}) in total, but products cost ${products} (VAT ${productTax})`);
    }
  }

  // Numbers: every series runs 1, 2, 3... with no gap or repeat, and dates never go backwards.
  const series = new Map<string, IssuedDocument[]>();
  for (const d of docs.values()) {
    const s = d.invoice.number.slice(0, 5);
    series.set(s, [...(series.get(s) ?? []), d]);
  }
  for (const [s, list] of series) {
    list.sort((a, b) => a.invoice.number.localeCompare(b.invoice.number));
    const numbers = list.map((d) => Number(d.invoice.number.slice(6)));
    expect(numbers.every((n, i) => n === i + 1), () => `series ${s}: numbers aren't 1..${list.length} without gaps`);
    expect(list.every((d, i) => i === 0 || d.invoice.issueDate >= list[i - 1]!.invoice.issueDate), () => `series ${s}: a later number has an earlier date`);
    expect(list.every((d) => d.invoice.issueDate.startsWith(s.slice(1))), () => `series ${s}: an invoice is dated in another year`);
    fact(`series ${s}`);
  }
  const issuedOrders = sims.filter((s) => !((s.taxId === "invalid" || (s.taxId === "none" && s.charged > 300_000n)) && !s.correction));
  const expectedDocs = issuedOrders.length + issuedOrders.reduce((n, s) => n + s.refunds.filter((r) => r.expected.units > 0).length, 0);
  expect(docs.size === expectedDocs, () => `${docs.size} documents for ${expectedDocs} orders and refunds`);

  // The Verifactu chain verifies, and any tampering is caught at the right place.
  const ledger = service.ledger;
  // The auditor's own reading of AEAT's hash rule: these fields, in this order.
  const SPEC = {
    alta: ["IDEmisorFactura", "NumSerieFactura", "FechaExpedicionFactura", "TipoFactura", "CuotaTotal", "ImporteTotal", "Huella", "FechaHoraHusoGenRegistro"],
    anulacion: ["IDEmisorFacturaAnulada", "NumSerieFacturaAnulada", "FechaExpedicionFacturaAnulada", "Huella", "FechaHoraHusoGenRegistro"],
  };
  let previous = "";
  ledger.forEach((r, i) => {
    const f = r.fields as unknown as Record<string, string>;
    const keys = "IDEmisorFacturaAnulada" in f ? SPEC.anulacion : SPEC.alta;
    const own = createHash("sha256").update(keys.map((k) => `${k}=${f[k]!.trim()}`).join("&"), "utf8").digest("hex").toUpperCase();
    expect(own === r.fingerprint, () => `record ${i}: fingerprint doesn't follow the AEAT rule`);
    expect(f.Huella === previous, () => `record ${i}: doesn't point at the record before it`);
    previous = r.fingerprint;
  });
  expect(ledger.length === docs.size, () => `${ledger.length} records for ${docs.size} documents`);
  expect((await verifyChain(ledger)).ok, () => "the Verifactu chain doesn't verify");
  if (ledger.length > 10) {
    const mid = Math.floor(ledger.length / 2);
    const edited: ChainedRecord[] = ledger.map((r, i) => (i === mid ? { ...r, fields: { ...r.fields, ImporteTotal: "0.01" } as ChainedRecord["fields"] } : r));
    const removed = ledger.filter((_, i) => i !== mid);
    const swapped = [...ledger]; [swapped[mid], swapped[mid + 1]] = [swapped[mid + 1]!, swapped[mid]!];
    const res = await Promise.all([verifyChain(edited), verifyChain(removed), verifyChain(swapped)]);
    expect(res.every((r) => !r.ok && r.index === mid), () => `tampering not caught at record ${mid}: ${JSON.stringify(res)}`);
  }

  return {
    orders: sims.length, refunds: sims.reduce((n, s) => n + s.refunds.length, 0), deliveries: events.length,
    documents: docs.size, records: ledger.length, checks, failures, facts, seconds: (Date.now() - started) / 1000,
  };
}
