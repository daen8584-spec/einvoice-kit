import type { DatabaseSync as Database } from "node:sqlite";
import { InvoiceService } from "../src/app.js";
import { fromGraphQL } from "../src/shopify/from-graphql.js";
import { pack, unpack, type Cipher } from "../src/crypto.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { loadSettings, UNCONFIGURED } from "./db.js";
import { saveCopies } from "./copies.js";
import { AccessDenied, ShopifyUnavailable, type ShopifyClient } from "./shopify.js";

export const TOPICS = {
  orderPaid: "orders/paid",
  orderUpdated: "orders/updated",
  refundCreated: "refunds/create",
  uninstalled: "app/uninstalled",
  /** Not from Shopify: queued by the app when held documents should be tried again. */
  retryHeld: "app/retry_held",
} as const;
export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"];

const MAX_ATTEMPTS = 12;

/** Stored with the event; permission problems get a prefix the admin page can recognise. */
function describe(error: unknown): string {
  if (error instanceof AccessDenied) return `access:${error.fields.join(",")}`;
  return String(error instanceof Error ? error.message : error);
}
const backoff = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attempts - 1));

interface InboxRow {
  webhook_id: string;
  shop: string;
  topic: string;
  payload: string;
  attempts: number;
}

/**
 * Works through saved webhooks. Each shop's events run one at a time, oldest
 * first, so invoice numbers follow the order they were handled in; different
 * shops run side by side.
 */
export class Worker {
  private draining: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly db: Database,
    private readonly shopify: ShopifyClient,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = () => {},
    /** Encrypts saved notifications and the shop's documents. */
    private readonly cipher?: Cipher,
  ) {}

  /** Saves an event. Returns false when this delivery was already saved. */
  enqueue(webhookId: string, shop: string, topic: string, payload: string): boolean {
    const r = this.db
      .prepare("insert or ignore into inbox (webhook_id, shop, topic, payload, received_at) values (?, ?, ?, ?, ?)")
      .run(webhookId, shop, topic, this.cipher ? pack(payload, this.cipher) : payload, new Date(this.now()).toISOString());
    return r.changes > 0;
  }

  /** Makes everything waiting for a shop due now, including events that gave up, after the merchant fixed something. */
  retryNow(shop: string): void {
    this.db.prepare("update inbox set status = 'pending', next_attempt_at = 0 where shop = ? and status in ('pending', 'failed')").run(shop);
  }

  /** Why this shop's events are stuck, if Shopify refused the app access to some fields. */
  missingAccess(shop: string): string[] {
    const rows = this.db.prepare("select last_error from inbox where shop = ? and status in ('pending', 'failed') and last_error like 'access:%'").all(shop) as { last_error: string }[];
    return [...new Set(rows.flatMap((r) => r.last_error.slice("access:".length).split(",")).filter(Boolean))];
  }

  /** Processes everything that's due. Safe to call often; runs one pass at a time. */
  drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        const due = this.db
          .prepare("select webhook_id, shop, topic, payload, attempts from inbox where status = 'pending' and next_attempt_at <= ? order by received_at, rowid")
          .all(this.now()) as unknown as InboxRow[];
        const byShop = new Map<string, InboxRow[]>();
        for (const row of due) byShop.set(row.shop, [...(byShop.get(row.shop) ?? []), row]);
        await Promise.all([...byShop.values()].map((rows) => this.runShop(rows)));
        await this.copyAll();
      } while (this.again);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /**
   * Copies new documents into each installed shop's own Shopify orders. A copy
   * that can't be saved now is tried on the next pass; invoicing never waits for it.
   */
  private async copyAll(): Promise<void> {
    const shops = this.db
      .prepare(
        `select distinct d.shop from documents d join shops s on s.shop = d.shop and s.access_token is not null
         where not exists (select 1 from copies c where c.shop = d.shop and c.key = d.key)`,
      )
      .all() as { shop: string }[];
    for (const { shop } of shops) {
      try {
        await saveCopies(this.db, this.shopify, shop, this.service(shop).store.allDocuments());
        this.db.prepare("delete from copy_errors where shop = ?").run(shop);
      } catch (error) {
        this.db.prepare("insert or replace into copy_errors (shop, error, at) values (?, ?, ?)").run(shop, describe(error), new Date(this.now()).toISOString());
        this.log(`${shop} copies: ${String(error)}`);
      }
    }
  }

  /** How many documents are copied into the shop's orders, and why the rest aren't yet. */
  copyStatus(shop: string): { saved: number; total: number; error: string | null } {
    const saved = this.db.prepare("select count(*) as n from copies c join documents d on d.shop = c.shop and d.key = c.key where c.shop = ?").get(shop) as { n: number };
    const total = this.db.prepare("select count(*) as n from documents where shop = ?").get(shop) as { n: number };
    const err = this.db.prepare("select error from copy_errors where shop = ?").get(shop) as { error: string } | undefined;
    return { saved: Number(saved.n), total: Number(total.n), error: err?.error ?? null };
  }

  private async runShop(rows: InboxRow[]): Promise<void> {
    for (const row of rows) {
      try {
        await this.handle(row);
        // Done: the notification's contents (which can include customer details) aren't kept.
        this.db.prepare("update inbox set status = 'done', processed_at = ?, last_error = null, payload = '' where webhook_id = ?").run(new Date(this.now()).toISOString(), row.webhook_id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS && !(error instanceof ShopifyUnavailable);
        this.db
          .prepare("update inbox set attempts = ?, next_attempt_at = ?, last_error = ?, status = ? where webhook_id = ?")
          .run(attempts, this.now() + backoff(attempts), describe(error), giveUp ? "failed" : "pending", row.webhook_id);
        this.log(`${row.shop} ${row.topic} ${row.webhook_id}: ${String(error)}`);
        // Later events carry on: the invoicing handles events in any order, and
        // one stuck event must not stop a shop's invoicing.
      }
    }
  }

  service(shop: string): InvoiceService {
    const settings = loadSettings(this.db, shop) ?? UNCONFIGURED;
    return new InvoiceService(settings, new SqliteStore(this.db, shop, this.cipher), () => new Date(this.now()));
  }

  private async handle(row: InboxRow): Promise<void> {
    const text = row.payload.startsWith("enc1:") ? unpack<string>(row.payload, this.cipher) : row.payload;
    const payload = JSON.parse(text) as Record<string, unknown> & { id?: number; order_id?: number };
    const app = this.service(row.shop);

    switch (row.topic) {
      case TOPICS.orderPaid: {
        await this.processOrder(app, row.shop, Number(payload.id));
        return;
      }
      case TOPICS.orderUpdated: {
        // Only matters when the order's invoice is waiting for a fix.
        if (!app.store.heldDocument(`order:${payload.id}`)) return;
        await this.processOrder(app, row.shop, Number(payload.id));
        return;
      }
      case TOPICS.refundCreated: {
        const raw = await this.shopify.fetchOrder(row.shop, Number(payload.order_id));
        if (!raw) throw new Error(`order ${payload.order_id} not found`);
        const order = fromGraphQL(raw);
        const index = order.refunds!.findIndex((r) => r.id === Number(payload.id));
        if (index === -1) throw new ShopifyUnavailable(`refund ${payload.id} isn't on order ${order.name} yet`);
        await app.onRefund({ ...order, refunds: order.refunds!.slice(0, index + 1) }, order.refunds![index]!);
        return;
      }
      case TOPICS.retryHeld: {
        for (const held of app.store.allHeld()) {
          const [kind, id] = held.key.split(":");
          if (kind === "order") await this.processOrder(app, row.shop, Number(id));
        }
        return;
      }
      case TOPICS.uninstalled: {
        this.shopify.forget(row.shop);
        return;
      }
      case "shop/redact": {
        // Shopify sends this 48 hours after a shop uninstalls the app: delete everything.
        deleteShop(this.db, row.shop);
        this.record(row.shop, row.topic, {});
        return;
      }
      default:
        if (COMPLIANCE_TOPICS.includes(row.topic)) {
          // Only which orders were involved: the customer's email and phone aren't kept.
          const orders = (payload.orders_requested ?? payload.orders_to_redact ?? []) as number[];
          this.record(row.shop, row.topic, { orders });
          return;
        }
        this.log(`ignoring unknown topic ${row.topic}`);
    }
  }

  private record(shop: string, topic: string, details: object): void {
    this.db
      .prepare("insert into compliance_requests (shop, topic, payload, received_at) values (?, ?, ?, ?)")
      .run(shop, topic, JSON.stringify(details), new Date(this.now()).toISOString());
  }

  /** Processed notifications are forgotten after 30 days. */
  purge(): number {
    const cutoff = new Date(this.now() - 30 * 24 * 3600_000).toISOString();
    return Number(this.db.prepare("delete from inbox where status = 'done' and processed_at < ?").run(cutoff).changes);
  }

  private async processOrder(app: InvoiceService, shop: string, id: number): Promise<void> {
    const raw = await this.shopify.fetchOrder(shop, id);
    if (!raw) throw new Error(`order ${id} not found`);
    await app.onOrder(fromGraphQL(raw));
  }
}

/** Every trace of a shop: invoices, records, settings, tokens and notifications. */
export function deleteShop(db: Database, shop: string): void {
  db.exec("begin immediate");
  try {
    for (const table of ["documents", "ledger", "series", "held", "skipped", "waiting_refunds", "settings", "agreements", "copies", "copy_errors", "shops", "inbox"])
      db.prepare(`delete from ${table} where shop = ?`).run(shop);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
