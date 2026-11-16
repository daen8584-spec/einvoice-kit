import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { ChainedRecord } from "./es/verifactu.js";
import {
  assertCommittable,
  type DocumentStore,
  type HeldDocument,
  type IssuedDocument,
  type SkippedRefund,
  type WaitingRefund,
} from "./store.js";

// Loaded this way because bundlers don't all know `node:sqlite` yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
  pragma journal_mode = wal;
  pragma foreign_keys = on;
  pragma busy_timeout = 5000;

  create table if not exists series (
    shop text not null, series text not null, last integer not null,
    primary key (shop, series)
  );
  create table if not exists ledger (
    shop text not null, seq integer not null, fingerprint text not null, record text not null,
    primary key (shop, seq)
  );
  create table if not exists documents (
    shop text not null, key text not null, number text not null, issue_date text not null,
    total integer not null, seq integer not null, doc text not null,
    primary key (shop, key),
    unique (shop, number),
    foreign key (shop, seq) references ledger (shop, seq)
  );
  create table if not exists held (
    shop text not null, key text not null, doc text not null, updated_at text not null,
    primary key (shop, key)
  );
  create table if not exists skipped (
    shop text not null, key text not null, doc text not null,
    primary key (shop, key)
  );
  create table if not exists waiting_refunds (
    shop text not null, order_id integer not null, refund_id integer not null, entry text not null,
    primary key (shop, order_id, refund_id)
  );
`;

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, column = "doc"): T | undefined => {
  const row = value as Row | undefined;
  return row ? (JSON.parse(String(row[column])) as T) : undefined;
};

/** One shop's documents in a SQLite database. Several shops can share a database. */
export class SqliteStore implements DocumentStore {
  constructor(
    private readonly db: Database,
    private readonly shop: string,
  ) {}

  document(key: string) {
    return parse<IssuedDocument>(this.db.prepare("select doc from documents where shop = ? and key = ?").get(this.shop, key));
  }
  skippedRefund(key: string) {
    return parse<SkippedRefund>(this.db.prepare("select doc from skipped where shop = ? and key = ?").get(this.shop, key));
  }
  heldDocument(key: string) {
    return parse<HeldDocument>(this.db.prepare("select doc from held where shop = ? and key = ?").get(this.shop, key));
  }

  lastNumber(series: string) {
    const row = this.db.prepare("select last from series where shop = ? and series = ?").get(this.shop, series) as Row | undefined;
    return row ? Number(row.last) : 0;
  }
  lastFingerprint() {
    const row = this.db.prepare("select fingerprint from ledger where shop = ? order by seq desc limit 1").get(this.shop) as Row | undefined;
    return row ? String(row.fingerprint) : "";
  }

  /** All in one transaction: the number, the record and the document, or none of them. */
  commit(series: string, number: number, doc: IssuedDocument): void {
    this.db.exec("begin immediate");
    try {
      assertCommittable(this, series, number, doc);
      const seqRow = this.db.prepare("select coalesce(max(seq), 0) + 1 as next from ledger where shop = ?").get(this.shop) as Row;
      const seq = Number(seqRow.next);
      this.db
        .prepare("insert into series (shop, series, last) values (?, ?, ?) on conflict (shop, series) do update set last = excluded.last")
        .run(this.shop, series, number);
      this.db
        .prepare("insert into ledger (shop, seq, fingerprint, record) values (?, ?, ?, ?)")
        .run(this.shop, seq, doc.record.fingerprint, JSON.stringify(doc.record));
      this.db
        .prepare("insert into documents (shop, key, number, issue_date, total, seq, doc) values (?, ?, ?, ?, ?, ?, ?)")
        .run(this.shop, doc.key, doc.invoice.number, doc.invoice.issueDate, doc.totals.total, seq, JSON.stringify(doc));
      this.db.prepare("delete from held where shop = ? and key = ?").run(this.shop, doc.key);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  saveSkipped(doc: SkippedRefund) {
    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from held where shop = ? and key = ?").run(this.shop, doc.key);
      this.db.prepare("insert or replace into skipped (shop, key, doc) values (?, ?, ?)").run(this.shop, doc.key, JSON.stringify(doc));
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  saveHeld(doc: HeldDocument) {
    this.db
      .prepare("insert or replace into held (shop, key, doc, updated_at) values (?, ?, ?, ?)")
      .run(this.shop, doc.key, JSON.stringify(doc), new Date().toISOString());
  }

  addWaitingRefund(orderId: number, entry: WaitingRefund) {
    this.db
      .prepare("insert or replace into waiting_refunds (shop, order_id, refund_id, entry) values (?, ?, ?, ?)")
      .run(this.shop, orderId, entry.refund.id, JSON.stringify(entry));
  }
  waitingRefunds(orderId: number) {
    return this.db
      .prepare("select entry from waiting_refunds where shop = ? and order_id = ?")
      .all(this.shop, orderId)
      .map((r) => parse<WaitingRefund>(r, "entry")!);
  }
  removeWaitingRefund(orderId: number, refundId: number) {
    this.db.prepare("delete from waiting_refunds where shop = ? and order_id = ? and refund_id = ?").run(this.shop, orderId, refundId);
  }

  allDocuments() {
    return this.db.prepare("select doc from documents where shop = ? order by seq").all(this.shop).map((r) => parse<IssuedDocument>(r)!);
  }
  allSkipped() {
    return this.db.prepare("select doc from skipped where shop = ?").all(this.shop).map((r) => parse<SkippedRefund>(r)!);
  }
  allHeld() {
    return this.db.prepare("select doc from held where shop = ? order by updated_at").all(this.shop).map((r) => parse<HeldDocument>(r)!);
  }
  ledger() {
    return this.db.prepare("select record from ledger where shop = ? order by seq").all(this.shop).map((r) => parse<ChainedRecord>(r, "record")!);
  }
}
