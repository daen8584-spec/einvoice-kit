import { computeTotals, type Invoice, type Totals } from "./invoice.js";
import { MemorySequenceStore, nextNumber, type SequenceStore } from "./numbering.js";
import { checkSpanishInvoice, type Issue } from "./es/check.js";
import { RecordChain, type ChainedRecord } from "./es/verifactu.js";
import { localDate, orderToInvoice, refundToCreditNote, type ShopSettings } from "./shopify/to-invoice.js";
import type { ShopifyOrder, ShopifyRefund } from "./shopify/types.js";

export interface IssuedDocument {
  key: string;
  invoice: Invoice;
  totals: Totals;
  record: ChainedRecord;
  warnings: string[];
  issues: Issue[];
}

/**
 * What the app does when Shopify notifies it of an order or a refund.
 *
 * Shopify can send the same notification more than once, out of order, or
 * several at the same moment. Every document is therefore created at most once
 * per order or refund, and documents are issued one at a time, so invoice numbers
 * and the Verifactu chain always follow the same order with no gaps.
 */
export interface SkippedRefund {
  key: string;
  skipped: true;
  warnings: string[];
}

export type Outcome = IssuedDocument | SkippedRefund;

export class InvoiceService {
  readonly documents = new Map<string, IssuedDocument>();
  /** Refunds with nothing left to credit. They use no number and no record. */
  readonly skipped = new Map<string, SkippedRefund>();
  /** Every Verifactu record, in the order it was generated. */
  readonly ledger: ChainedRecord[] = [];
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: ShopSettings,
    private readonly sequences: SequenceStore = new MemorySequenceStore(),
    private readonly chain = new RecordChain(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  onOrder(order: ShopifyOrder): Promise<IssuedDocument> {
    return this.once(`order:${order.id}`, async (key): Promise<IssuedDocument> => {
      const issuedAt = this.clock();
      const number = await nextNumber(this.sequences, "F", this.issueDate(issuedAt), key);
      const { invoice, warnings } = orderToInvoice(order, this.settings, number, issuedAt);
      return this.issue(key, invoice, warnings, issuedAt);
    }) as Promise<IssuedDocument>;
  }

  /** Issues the order's invoice first if its notification hasn't arrived yet. */
  async onRefund(order: ShopifyOrder, refund: ShopifyRefund): Promise<Outcome> {
    const original = await this.onOrder(order);
    return this.once(`refund:${refund.id}`, async (key) => {
      const issuedAt = this.clock();
      // Work out the credit note before taking a number, so a refund with nothing
      // to credit doesn't leave a gap in the series.
      const draft = refundToCreditNote(order, refund, original.invoice, this.settings, "", issuedAt);
      if (draft.invoice.lines.length === 0)
        return { key, skipped: true, warnings: [...draft.warnings, `Refund ${refund.id} has nothing left to credit, so no credit note was issued.`] };
      const number = await nextNumber(this.sequences, "R", this.issueDate(issuedAt), key);
      return this.issue(key, { ...draft.invoice, number }, draft.warnings, issuedAt);
    });
  }

  private issueDate(at: Date): string {
    return localDate(at.toISOString(), this.settings.timeZone ?? "Europe/Madrid");
  }

  private async issue(key: string, invoice: Invoice, warnings: string[], at: Date): Promise<IssuedDocument> {
    const totals = computeTotals(invoice);
    const { issues } = checkSpanishInvoice(invoice, { today: invoice.issueDate });
    const record = await this.chain.register(invoice, at);
    this.ledger.push(record);
    return { key, invoice, totals, record, warnings, issues };
  }

  /** Runs `make` once per key, and only one document at a time across all keys. */
  private once(key: string, make: (key: string) => Promise<Outcome>): Promise<Outcome> {
    const done = this.documents.get(key) ?? this.skipped.get(key);
    if (done) return Promise.resolve(done);
    const running = this.inFlight.get(key);
    if (running) return running;

    const job = this.queue.then(async () => {
      const again = this.documents.get(key) ?? this.skipped.get(key);
      if (again) return again;
      const outcome = await make(key);
      if ("skipped" in outcome) this.skipped.set(key, outcome);
      else this.documents.set(key, outcome);
      return outcome;
    });
    this.queue = job.catch(() => undefined);
    this.inFlight.set(key, job);
    void job.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return job;
  }
}
