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

/**
 * Not issued, because something is wrong (for example a mistyped tax ID) or the
 * invoice a refund belongs to is itself on hold. No number is used and nothing
 * reaches the Verifactu chain. It's issued automatically once Shopify sends the
 * corrected order.
 */
export interface HeldDocument {
  key: string;
  held: true;
  draft: Invoice;
  issues: Issue[];
  warnings: string[];
}

export type Outcome = IssuedDocument | SkippedRefund | HeldDocument;

const errorsIn = (issues: Issue[]) => issues.filter((i) => i.level === "error");

/**
 * What the app does when Shopify notifies it of an order or a refund.
 *
 * Shopify can send the same notification more than once, out of order, or
 * several at the same moment. Every document is therefore created at most once
 * per order or refund, and documents are issued one at a time, so invoice numbers
 * and the Verifactu chain always follow the same order with no gaps. A document
 * that fails any check is held, never issued.
 */
export class InvoiceService {
  readonly documents = new Map<string, IssuedDocument>();
  /** Refunds with nothing left to credit. They use no number and no record. */
  readonly skipped = new Map<string, SkippedRefund>();
  readonly held = new Map<string, HeldDocument>();
  /** Every Verifactu record, in the order it was generated. */
  readonly ledger: ChainedRecord[] = [];
  private readonly heldRefunds = new Map<number, Map<number, { order: ShopifyOrder; refund: ShopifyRefund }>>();
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: ShopSettings,
    private readonly sequences: SequenceStore = new MemorySequenceStore(),
    private readonly chain = new RecordChain(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Handles "order created" and "order updated" alike. */
  async onOrder(order: ShopifyOrder): Promise<IssuedDocument | HeldDocument> {
    const outcome = (await this.once(`order:${order.id}`, async (key) => {
      const issuedAt = this.clock();
      const draft = orderToInvoice(order, this.settings, this.placeholder("F", issuedAt), issuedAt);
      const { issues } = checkSpanishInvoice(draft.invoice, { today: draft.invoice.issueDate });
      if (errorsIn(issues).length) return { key, held: true, draft: draft.invoice, issues, warnings: draft.warnings };
      const number = await nextNumber(this.sequences, "F", draft.invoice.issueDate, key);
      return this.issue(key, { ...draft.invoice, number }, draft.warnings, issues, issuedAt);
    })) as IssuedDocument | HeldDocument;

    // Refunds that were waiting for this invoice can go out now.
    const waiting = this.heldRefunds.get(order.id);
    if (!("held" in outcome) && waiting?.size) {
      this.heldRefunds.delete(order.id);
      for (const { order: o, refund } of [...waiting.values()].sort((a, b) => a.refund.created_at.localeCompare(b.refund.created_at)))
        await this.onRefund(o, refund);
    }
    return outcome;
  }

  /** Issues the order's invoice first if its notification hasn't arrived yet. */
  async onRefund(order: ShopifyOrder, refund: ShopifyRefund): Promise<Outcome> {
    const original = await this.onOrder(order);
    return this.once(`refund:${refund.id}`, async (key) => {
      const issuedAt = this.clock();
      if ("held" in original) {
        const waiting = this.heldRefunds.get(order.id) ?? new Map();
        waiting.set(refund.id, { order, refund });
        this.heldRefunds.set(order.id, waiting);
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
      const number = await nextNumber(this.sequences, "R", draft.invoice.issueDate, key);
      return this.issue(key, { ...draft.invoice, number }, draft.warnings, issues, issuedAt);
    });
  }

  /** A number in the right format for checking a draft; never issued. */
  private placeholder(prefix: string, at: Date): string {
    return `${prefix}${this.issueDate(at).slice(0, 4)}-000000`;
  }

  private issueDate(at: Date): string {
    return localDate(at.toISOString(), this.settings.timeZone ?? "Europe/Madrid");
  }

  private async issue(key: string, invoice: Invoice, warnings: string[], issues: Issue[], at: Date): Promise<IssuedDocument> {
    const record = await this.chain.register(invoice, at);
    this.ledger.push(record);
    return { key, invoice, totals: computeTotals(invoice), record, warnings, issues };
  }

  /**
   * Runs `make` at most once per key (a held document is tried again), and only
   * one document at a time across all keys.
   */
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
      else if ("held" in outcome) this.held.set(key, outcome);
      else {
        this.held.delete(key);
        this.documents.set(key, outcome);
      }
      return outcome;
    });
    this.queue = job.catch(() => undefined);
    this.inFlight.set(key, job);
    void job.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return job;
  }
}
