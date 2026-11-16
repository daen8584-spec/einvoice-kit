import type { Invoice, Totals } from "./invoice.js";
import type { Issue } from "./es/check.js";
import type { ChainedRecord } from "./es/verifactu.js";
import type { ShopifyOrder, ShopifyRefund } from "./shopify/types.js";

export interface IssuedDocument {
  key: string;
  invoice: Invoice;
  totals: Totals;
  record: ChainedRecord;
  warnings: string[];
  issues: Issue[];
}

/** A refund with nothing left to credit. It uses no number and no record. */
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

export interface WaitingRefund {
  order: ShopifyOrder;
  refund: ShopifyRefund;
}

/**
 * Everything one shop's invoicing needs to remember. `commit` is the only way a
 * document is issued, and it must save the number, the document and the
 * Verifactu record together or not at all: a crash halfway must never leave a
 * used number without its invoice, or an invoice outside the chain.
 */
export interface DocumentStore {
  document(key: string): IssuedDocument | undefined;
  skippedRefund(key: string): SkippedRefund | undefined;
  heldDocument(key: string): HeldDocument | undefined;

  /** The last number issued in a series such as "F2026", or 0. */
  lastNumber(series: string): number;
  /** The fingerprint of the last Verifactu record, or "" before the first one. */
  lastFingerprint(): string;

  /**
   * Issues `doc` as number `number` of `series`. Refuses, changing nothing, unless
   * `number` is the next one and the record points at the current last record.
   */
  commit(series: string, number: number, doc: IssuedDocument): void;
  saveSkipped(doc: SkippedRefund): void;
  saveHeld(doc: HeldDocument): void;

  addWaitingRefund(orderId: number, entry: WaitingRefund): void;
  /** Refunds waiting for an order's invoice. Each stays until it's been dealt with. */
  waitingRefunds(orderId: number): WaitingRefund[];
  removeWaitingRefund(orderId: number, refundId: number): void;

  allDocuments(): IssuedDocument[];
  allSkipped(): SkippedRefund[];
  allHeld(): HeldDocument[];
  /** Every Verifactu record, in the order it was generated. */
  ledger(): ChainedRecord[];
}

export class StoreConflict extends Error {}

/** Checks shared by every store before a commit changes anything. */
export function assertCommittable(store: DocumentStore, series: string, number: number, doc: IssuedDocument): void {
  const expected = store.lastNumber(series) + 1;
  if (number !== expected) throw new StoreConflict(`${series}: tried to issue number ${number}, but the next one is ${expected}`);
  if (doc.record.fields.Huella !== store.lastFingerprint()) throw new StoreConflict("the record doesn't point at the last record in the chain");
  if (store.document(doc.key)) throw new StoreConflict(`${doc.key} was already issued`);
}

export class MemoryStore implements DocumentStore {
  private readonly documents = new Map<string, IssuedDocument>();
  private readonly skipped = new Map<string, SkippedRefund>();
  private readonly held = new Map<string, HeldDocument>();
  private readonly series = new Map<string, number>();
  private readonly records: ChainedRecord[] = [];
  private readonly waiting = new Map<number, Map<number, WaitingRefund>>();

  document(key: string) { return this.documents.get(key); }
  skippedRefund(key: string) { return this.skipped.get(key); }
  heldDocument(key: string) { return this.held.get(key); }
  lastNumber(series: string) { return this.series.get(series) ?? 0; }
  lastFingerprint() { return this.records.at(-1)?.fingerprint ?? ""; }

  commit(series: string, number: number, doc: IssuedDocument): void {
    assertCommittable(this, series, number, doc);
    this.series.set(series, number);
    this.documents.set(doc.key, doc);
    this.held.delete(doc.key);
    this.records.push(doc.record);
  }

  saveSkipped(doc: SkippedRefund) { this.held.delete(doc.key); this.skipped.set(doc.key, doc); }
  saveHeld(doc: HeldDocument) { this.held.set(doc.key, doc); }

  addWaitingRefund(orderId: number, entry: WaitingRefund) {
    const forOrder = this.waiting.get(orderId) ?? new Map<number, WaitingRefund>();
    forOrder.set(entry.refund.id, entry);
    this.waiting.set(orderId, forOrder);
  }
  waitingRefunds(orderId: number) {
    return [...(this.waiting.get(orderId)?.values() ?? [])];
  }
  removeWaitingRefund(orderId: number, refundId: number) {
    this.waiting.get(orderId)?.delete(refundId);
  }

  allDocuments() { return [...this.documents.values()]; }
  allSkipped() { return [...this.skipped.values()]; }
  allHeld() { return [...this.held.values()]; }
  ledger() { return [...this.records]; }
}
