import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import order from "./fixtures/order-es.json";
import { InvoiceService } from "../src/app.js";
import { verifyChain } from "../src/es/verify.js";
import { Cipher } from "../src/crypto.js";
import { encryptExistingRows, openDatabase, SqliteStore } from "../src/sqlite-store.js";
import { MemoryStore, StoreConflict, type DocumentStore, type IssuedDocument } from "../src/store.js";
import type { ShopifyOrder } from "../src/shopify/types.js";
import { runSimulation } from "./sim/run.js";

const o = order as ShopifyOrder;
const shop = { seller: { name: "Tienda Ejemplo SL", taxId: "A28015865" } };
const clock = () => new Date("2026-04-01T09:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "einvoice-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stores: [string, () => DocumentStore][] = [
  ["memory", () => new MemoryStore()],
  ["SQLite", () => new SqliteStore(openDatabase(":memory:"), "test.myshopify.com")],
];

describe.each(stores)("%s store", (_name, make) => {
  it("refuses a number that isn't the next one, a broken chain link and a duplicate", async () => {
    const store = make();
    const app = new InvoiceService(shop, store, clock);
    const doc = (await app.onOrder(o)) as IssuedDocument;
    expect(() => store.commit("F2026", 1, { ...doc, key: "order:other" })).toThrow(StoreConflict);
    expect(() => store.commit("F2026", 3, { ...doc, key: "order:other" })).toThrow(StoreConflict);
    const brokenLink = { ...doc, key: "order:other", record: { ...doc.record, fields: { ...doc.record.fields, Huella: "" } } };
    expect(() => store.commit("F2026", 2, brokenLink)).toThrow(StoreConflict);
    expect(() => store.commit("F2026", 2, { ...doc, record: { ...doc.record, fields: { ...doc.record.fields, Huella: doc.record.fingerprint } } })).toThrow(StoreConflict);
    expect(store.lastNumber("F2026")).toBe(1);
    expect(store.ledger()).toHaveLength(1);
  });

  it("runs the whole store simulation with the same results", async () => {
    const report = await runSimulation(1500, 77, make());
    expect(report.failures).toEqual([]);
  }, 300_000);
});

describe("SQLite store", () => {
  it("saves nothing when issuing fails halfway: no used number, no record", async () => {
    const store = new SqliteStore(openDatabase(":memory:"), "test.myshopify.com");
    const app = new InvoiceService(shop, store, clock);
    const good = (await app.onOrder(o)) as IssuedDocument;
    const next = { ...good, key: "order:2", invoice: { ...good.invoice, number: "F2026-000002" }, record: { ...good.record, fields: { ...good.record.fields, Huella: good.record.fingerprint } } };
    // A value JSON can't hold makes the very last write of the commit fail.
    const poisoned = { ...next, warnings: [10n] } as unknown as IssuedDocument;
    expect(() => store.commit("F2026", 2, poisoned)).toThrow();
    expect(store.lastNumber("F2026")).toBe(1);
    expect(store.ledger()).toHaveLength(1);
    expect(store.document("order:2")).toBeUndefined();
    store.commit("F2026", 2, next);
    expect(store.lastNumber("F2026")).toBe(2);
  });

  it("keeps everything after the database is closed and reopened", async () => {
    const path = join(dir, "shop.db");
    const first = openDatabase(path);
    await new InvoiceService(shop, new SqliteStore(first, "a.myshopify.com"), clock).onOrder(o);
    first.close();

    const store = new SqliteStore(openDatabase(path), "a.myshopify.com");
    expect(store.lastNumber("F2026")).toBe(1);
    expect(store.document(`order:${o.id}`)?.invoice.number).toBe("F2026-000001");
    const app = new InvoiceService(shop, store, () => new Date("2026-04-07T09:00:00Z"));
    await app.onRefund(o, o.refunds![0]!);
    expect(store.allDocuments().map((d) => d.invoice.number)).toEqual(["F2026-000001", "R2026-000001"]);
    expect(await verifyChain(store.ledger())).toEqual({ ok: true });
  });

  it("keeps shops apart in one database", async () => {
    const db = openDatabase(":memory:");
    await new InvoiceService(shop, new SqliteStore(db, "a.myshopify.com"), clock).onOrder(o);
    await new InvoiceService(shop, new SqliteStore(db, "b.myshopify.com"), clock).onOrder(o);
    for (const s of ["a.myshopify.com", "b.myshopify.com"]) {
      const store = new SqliteStore(db, s);
      expect(store.allDocuments().map((d) => d.invoice.number)).toEqual(["F2026-000001"]);
      expect(await verifyChain(store.ledger())).toEqual({ ok: true });
    }
  });
});

describe("encryption at rest", () => {
  const key = () => new Cipher(Buffer.alloc(32, 7)).derive("documents");
  // The fixture's customer gives a tax ID, so the invoice carries their name and address.
  const customerDetails = ["Papelería Martín", "B12345674", "Calle Mayor 12"];
  const rawText = (db: ReturnType<typeof openDatabase>) =>
    JSON.stringify([
      ...db.prepare("select * from documents").all(),
      ...db.prepare("select * from held").all(),
      ...db.prepare("select * from waiting_refunds").all(),
    ]);

  it("keeps customer details out of the database file, and reads them back", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db, "a.myshopify.com", key());
    const app = new InvoiceService(shop, store, clock);
    await app.onOrder(o);
    await app.onRefund(o, o.refunds![0]!);
    const raw = rawText(db);
    for (const detail of customerDetails) expect(raw).not.toContain(detail);
    expect(store.document(`order:${o.id}`)?.invoice.buyer?.name).toBe("Papelería Martín SL");
    // The Verifactu chain stays readable and checkable without the key.
    expect(await verifyChain(new SqliteStore(db, "a.myshopify.com").ledger())).toEqual({ ok: true });
  });

  it("encrypts held drafts too", async () => {
    const db = openDatabase(":memory:");
    const typo = { ...o, note_attributes: [{ name: "NIF", value: "B12345675" }] };
    await new InvoiceService(shop, new SqliteStore(db, "a.myshopify.com", key()), clock).onOrder(typo);
    expect(rawText(db)).not.toContain("Papelería Martín");
  });

  it("reads older unencrypted rows and encrypts them in place", async () => {
    const db = openDatabase(":memory:");
    await new InvoiceService(shop, new SqliteStore(db, "a.myshopify.com"), clock).onOrder(o);
    expect(rawText(db)).toContain("Papelería Martín");
    const store = new SqliteStore(db, "a.myshopify.com", key());
    expect(store.document(`order:${o.id}`)?.invoice.number).toBe("F2026-000001");
    expect(encryptExistingRows(db, key())).toBe(1);
    expect(encryptExistingRows(db, key())).toBe(0);
    expect(rawText(db)).not.toContain("Papelería Martín");
    expect(store.document(`order:${o.id}`)?.invoice.buyer?.taxId).toBe("B12345674");
  });

  it("can't be read without the key, or with another key", async () => {
    const db = openDatabase(":memory:");
    await new InvoiceService(shop, new SqliteStore(db, "a.myshopify.com", key()), clock).onOrder(o);
    expect(() => new SqliteStore(db, "a.myshopify.com").allDocuments()).toThrow(/no key/);
    expect(() => new SqliteStore(db, "a.myshopify.com", new Cipher(Buffer.alloc(32, 8))).allDocuments()).toThrow();
  });
});
