/**
 * Starts the Shopify app.
 *
 *   SHOPIFY_API_KEY        the app's client ID
 *   SHOPIFY_API_SECRET     the app's client secret
 *   TOKEN_ENCRYPTION_KEY   32 random bytes, base64: openssl rand -base64 32
 *   DATABASE_PATH          where the SQLite database lives (default data/einvoice.db)
 *   PORT, HOST             where to listen (default 3000 on all interfaces)
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "./app.js";
import { openAppDatabase } from "./db.js";
import { ShopifyClient, TokenCipher } from "./shopify.js";
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
const cipher = new TokenCipher(required("TOKEN_ENCRYPTION_KEY"));
const path = process.env.DATABASE_PATH ?? "data/einvoice.db";
mkdirSync(dirname(path), { recursive: true });

const db = openAppDatabase(path);
const shopify = new ShopifyClient({ apiKey, secret, cipher, db });
const worker = new Worker(db, shopify, Date.now, (msg) => console.warn(msg));
const app = buildApp({ apiKey, secret, db, shopify, worker, logger: true });

// Retries and anything left over from before a restart.
const timer = setInterval(() => void worker.drain(), 30_000);
void worker.drain();

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    await worker.drain();
    db.close();
    process.exit(0);
  });
