/**
 * Starts the Shopify app.
 *
 *   SHOPIFY_API_KEY        the app's client ID
 *   SHOPIFY_API_SECRET     the app's client secret
 *   TOKEN_ENCRYPTION_KEY   32 random bytes, base64: openssl rand -base64 32. If it's
 *                          missing, one is created next to the database and reused.
 *   DATABASE_PATH          where the SQLite database lives (default data/einvoice.db)
 *   PORT                   the port to listen on (default 3000)
 *   BIND_ADDRESS           the interface to listen on (default all)
 *
 * Shopify CLI's `shopify app dev` provides the first two and PORT. It also sets
 * HOST to the app's public URL, which is why the interface isn't read from HOST.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildApp } from "./app.js";
import { openAppDatabase } from "./db.js";
import { Cipher, pack } from "../src/crypto.js";
import { encryptExistingRows } from "../src/sqlite-store.js";
import { ShopifyClient } from "./shopify.js";
import { Worker } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See server/main.ts for the settings the app needs.`);
    process.exit(1);
  }
  return value;
}

const apiKey = required("SHOPIFY_API_KEY");
const secret = required("SHOPIFY_API_SECRET");
const path = process.env.DATABASE_PATH ?? "data/einvoice.db";
mkdirSync(dirname(path), { recursive: true });

/**
 * The master key. Access tokens are encrypted with it, and invoices with a key
 * derived from it. Losing it makes stored invoices unreadable, so keep it with the
 * database, and keep it out of the same backup when you can.
 */
function tokenKey(): string {
  if (process.env.TOKEN_ENCRYPTION_KEY) return process.env.TOKEN_ENCRYPTION_KEY;
  const file = join(dirname(path), "token-key");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    console.warn(`Created a token encryption key in ${file}. Keep it with the database.`);
  }
  return readFileSync(file, "utf8").trim();
}
const cipher = new Cipher(tokenKey());
const documents = cipher.derive("documents");

const db = openAppDatabase(path);
// Rows saved by versions that didn't encrypt them yet.
const encrypted = encryptExistingRows(db, documents);
const plainEvents = db.prepare("select webhook_id, payload from inbox where payload != '' and payload not like 'enc1:%'").all() as { webhook_id: string; payload: string }[];
for (const e of plainEvents) db.prepare("update inbox set payload = ? where webhook_id = ?").run(pack(e.payload, documents), e.webhook_id);
db.prepare("update inbox set payload = '' where status = 'done'").run();
if (encrypted + plainEvents.length) console.warn(`Encrypted ${encrypted + plainEvents.length} stored records.`);

const shopify = new ShopifyClient({ apiKey, secret, cipher, db });
const worker = new Worker(db, shopify, Date.now, (msg) => console.warn(msg), documents);
const app = buildApp({ apiKey, secret, db, shopify, worker, logger: true });

// Retries and anything left over from before a restart; old notifications forgotten.
const timer = setInterval(() => {
  void worker.drain();
  worker.purge();
}, 30_000);
void worker.drain();

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.BIND_ADDRESS ?? "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    await worker.drain();
    db.close();
    process.exit(0);
  });
