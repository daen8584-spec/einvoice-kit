import { computeTotals, type Invoice } from "./invoice.js";
import { formatNumber } from "./numbering.js";
import { checkSpanishInvoice, type Issue } from "./es/check.js";
import { fingerprint, registrationFields } from "./es/verifactu.js";
import { localDate, orderToInvoice, refundToCreditNote, type ShopSettings } from "./shopify/to-invoice.js";
import type { ShopifyOrder, ShopifyRefund } from "./shopify/types.js";
import { MemoryStore, type DocumentStore, type HeldDocument, type IssuedDocument, type Outcome } from "./store.js";

export type { HeldDocument, IssuedDocument, Outcome, SkippedRefund } from "./store.js";

const errorsIn = (issues: Issue[]) => issues.filter((i) => i.level === "error");

/**
 * What the app does when Shopify notifies it of an order or a refund.
 *
 * Shopify can send the same notification more than once, out of order, or
 * several at the same moment. Every document is therefore created at most once
 * per order or refund, and documents are issued one at a time, so invoice numbers
 * and the Verifactu chain always follow the same order with no gaps. A document
 * that fails any check is held, never issued.
 *
 * One service handles one shop. Run one process per store database: the queue
 * that keeps documents in order lives in memory.
 */
export class InvoiceService {
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: ShopSettings,
    readonly store: DocumentStore = new MemoryStore(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Issued documents by key. Builds a fresh map: keep it rather than calling this in a loop. */
  get documents(): ReadonlyMap<string, IssuedDocument> {
    return new Map(this.store.allDocuments().map((d) => [d.key, d]));
  }
  get skipped(): ReadonlyMap<string, Outcome> {
    return new Map(this.store.allSkipped().map((d) => [d.key, d]));
  }
  get held(): ReadonlyMap<string, HeldDocument> {
    return new Map(this.store.allHeld().map((d) => [d.key, d]));
  }
  get ledger() {
    return this.store.ledger();
  }

  /** Handles "order paid" and "order updated" alike. */
  async onOrder(order: ShopifyOrder): Promise<IssuedDocument | HeldDocument> {
    const outcome = await this.orderOutcome(order);
    if (!("held" in outcome)) await this.releaseWaitingRefunds(order.id, outcome);
    return outcome;
  }

  /** Issues the order's invoice first if its notification hasn't arrived yet. */
  async onRefund(order: ShopifyOrder, refund: ShopifyRefund): Promise<Outcome> {
    const original = await this.orderOutcome(order);
    // Earlier refunds that were waiting for this invoice go first, in order.
    if (!("held" in original)) await this.releaseWaitingRefunds(order.id, original);
    return this.refundOutcome(order, refund, original);
  }

  private orderOutcome(order: ShopifyOrder): Promise<IssuedDocument | HeldDocument> {
    return this.once(`order:${order.id}`, async (key) => {
      const issuedAt = this.clock();
      const draft = orderToInvoice(order, this.settings, this.placeholder("F", issuedAt), issuedAt);
      const { issues } = checkSpanishInvoice(draft.invoice, { today: draft.invoice.issueDate });
      if (errorsIn(issues).length) return { key, held: true, draft: draft.invoice, issues, warnings: draft.warnings };
      return this.issue(key, "F", draft.invoice, draft.warnings, issues, issuedAt);
    }) as Promise<IssuedDocument | HeldDocument>;
  }

  /**
   * Refunds that waited for a held invoice. Each leaves the waiting list only once
   * it's been dealt with, so a crash halfway loses none.
   */
  private async releaseWaitingRefunds(orderId: number, original: IssuedDocument): Promise<void> {
    const waiting = this.store.waitingRefunds(orderId).sort((a, b) => a.refund.created_at.localeCompare(b.refund.created_at));
    for (const { order, refund } of waiting) await this.refundOutcome(order, refund, original);
  }

  private async refundOutcome(order: ShopifyOrder, refund: ShopifyRefund, original: IssuedDocument | HeldDocument): Promise<Outcome> {
    const outcome = await this.once(`refund:${refund.id}`, async (key) => {
      const issuedAt = this.clock();
      if ("held" in original) {
        this.store.addWaitingRefund(order.id, { order, refund });
        const message = { level: "error" as const, code: "invoice-held", es: "La factura de este pedido está retenida. La rectificativa se emitirá cuando se corrija.", en: "This order's invoice is on hold. The credit note will be issued once it's corrected." };
        return { key, held: true, draft: original.draft, issues: [message], warnings: [] };
      }
      // Work out the credit note before taking a number, so a refund with nothing
      // to credit, or one that fails a check, doesn't leave a gap in the series.
      const draft = refundToCreditNote(order, refund, original.invoice, this.settings, this.placeholder("R", issuedAt), issuedAt);
      if (draft.invoice.lines.length === 0)
        return { key, skipped: true, warnings: [...draft.warnings, `Refund ${refund.id} has nothing left to credit, so no credit note was issued.`] };
      const { issues } = checkSpanishInvoice(draft.invoice, { today: draft.invoice.issueDate });
      if (errorsIn(issues).length) return { key, held: true, draft: draft.invoice, issues, warnings: draft.warnings };
      return this.issue(key, "R", draft.invoice, draft.warnings, issues, issuedAt);
    });
    if (!("held" in outcome)) this.store.removeWaitingRefund(order.id, refund.id);
    return outcome;
  }

  /** A number in the right format for checking a draft; never issued. */
  private placeholder(prefix: string, at: Date): string {
    return `${prefix}${this.issueDate(at).slice(0, 4)}-000000`;
  }

  private issueDate(at: Date): string {
    return localDate(at.toISOString(), this.settings.timeZone ?? "Europe/Madrid");
  }

  /**
   * Takes the next number, builds the Verifactu record and hands all of it to the
   * store in one commit. Nothing is saved until that commit, so a failure on the
   * way leaves no trace and the next attempt gets the same number.
   */
  private async issue(key: string, prefix: string, draft: Invoice, warnings: string[], issues: Issue[], at: Date): Promise<IssuedDocument> {
    const year = Number(draft.issueDate.slice(0, 4));
    const series = `${prefix}${year}`;
    const number = this.store.lastNumber(series) + 1;
    const invoice: Invoice = { ...draft, number: formatNumber(prefix, year, number) };
    const totals = computeTotals(invoice);
    const fields = registrationFields(invoice, this.store.lastFingerprint(), at, totals);
    const doc: IssuedDocument = { key, invoice, totals, record: { fields, fingerprint: await fingerprint(fields) }, warnings, issues };
    this.store.commit(series, number, doc);
    return doc;
  }

  /**
   * Runs `make` at most once per key (a held document is tried again), and only
   * one document at a time across all keys.
   */
  private once(key: string, make: (key: string) => Promise<Outcome>): Promise<Outcome> {
    const done = this.store.document(key) ?? this.store.skippedRefund(key);
    if (done) return Promise.resolve(done);
    const running = this.inFlight.get(key);
    if (running) return running;

    const job = this.queue.then(async () => {
      const again = this.store.document(key) ?? this.store.skippedRefund(key);
      if (again) return again;
      const outcome = await make(key);
      if ("skipped" in outcome) this.store.saveSkipped(outcome);
      else if ("held" in outcome) this.store.saveHeld(outcome);
      return outcome;
    });
    this.queue = job.catch(() => undefined);
    this.inFlight.set(key, job);
    void job.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return job;
  }
}
