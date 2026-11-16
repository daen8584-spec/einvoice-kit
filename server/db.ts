import type { DatabaseSync as Database } from "node:sqlite";
import { openDatabase } from "../src/sqlite-store.js";
import type { ShopSettings } from "../src/shopify/to-invoice.js";

const APP_SCHEMA = `
  create table if not exists shops (
    shop text primary key,
    access_token text, refresh_token text,
    expires_at integer, refresh_expires_at integer, scope text,
    installed_at text, uninstalled_at text
  );
  create table if not exists settings (
    shop text primary key, json text not null, updated_at text not null
  );
  -- Every webhook is saved here first and processed after, so nothing is lost if
  -- the app stops halfway. The delivery ID makes repeated deliveries harmless.
  create table if not exists inbox (
    webhook_id text primary key,
    shop text not null, topic text not null, payload text not null,
    received_at text not null,
    status text not null default 'pending',
    attempts integer not null default 0,
    next_attempt_at integer not null default 0,
    last_error text, processed_at text
  );
  create index if not exists inbox_due on inbox (status, next_attempt_at);
  -- Which version of the terms each shop accepted, and when.
  create table if not exists agreements (
    shop text not null, version integer not null, accepted_at text not null,
    primary key (shop, version)
  );
  create table if not exists compliance_requests (
    id integer primary key autoincrement,
    shop text not null, topic text not null, payload text not null, received_at text not null
  );
`;

export function openAppDatabase(path: string): Database {
  const db = openDatabase(path);
  db.exec(APP_SCHEMA);
  return db;
}

export function loadSettings(db: Database, shop: string): ShopSettings | null {
  const row = db.prepare("select json from settings where shop = ?").get(shop) as { json?: string } | undefined;
  return row?.json ? (JSON.parse(row.json) as ShopSettings) : null;
}

export function saveSettings(db: Database, shop: string, settings: ShopSettings): void {
  db.prepare("insert into settings (shop, json, updated_at) values (?, ?, ?) on conflict (shop) do update set json = excluded.json, updated_at = excluded.updated_at").run(
    shop,
    JSON.stringify(settings),
    new Date().toISOString(),
  );
}

/** Before the shop has entered its details, invoices are drafted with none and held. */
export const UNCONFIGURED: ShopSettings = { seller: { name: "" } };

/** Bump when the terms or the data processing agreement change: shops are asked to accept again. */
export const TERMS_VERSION = 1;
export const LEGAL_URL = "https://daen8584-spec.github.io/einvoice-kit/legal/";

export function termsAccepted(db: Database, shop: string): boolean {
  return Boolean(db.prepare("select 1 from agreements where shop = ? and version = ?").get(shop, TERMS_VERSION));
}

export function acceptTerms(db: Database, shop: string, at: Date): void {
  db.prepare("insert or ignore into agreements (shop, version, accepted_at) values (?, ?, ?)").run(shop, TERMS_VERSION, at.toISOString());
}
