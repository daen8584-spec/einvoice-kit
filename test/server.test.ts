import { createHmac, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import live from "./fixtures/live-2026-11-16.json";
import { buildApp, logSerializers } from "../server/app.js";
import { openAppDatabase } from "../server/db.js";
import { ShopifyClient, signIdToken, TokenCipher } from "../server/shopify.js";
import { TOPICS, Worker } from "../server/worker.js";
import { Cipher } from "../src/crypto.js";
import { verifyChain } from "../src/es/verify.js";
import { toCents } from "../src/money.js";
import type { GraphQLOrder } from "../src/shopify/from-graphql.js";

const API_KEY = "test-client-id";
const SECRET = "test-client-secret";
const SHOP = "einvoice-test-es.myshopify.com";
const orders = live.orders as GraphQLOrder[];
const byName = (name: string) => orders.find((o) => o.name === name)!;

/** A stand-in for Shopify: the token endpoint and Admin GraphQL, serving the real test-store orders. */
class FakeShopify {
  accessToken = "";
  refreshToken = "";
  exchanges = 0;
  refreshes = 0;
  graphqlCalls = 0;
  down = false;
  rejectRefresh = false;
  /** Answer like Shopify does for an app not approved for customer names and addresses. */
  denyFields = false;
  /** How many of each order's refunds Shopify knows about so far. */
  refundsVisible = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (this.down) return new Response("unavailable", { status: 503 });
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_id") !== API_KEY || form.get("client_secret") !== SECRET) return new Response("{}", { status: 401 });
      if (form.get("grant_type") === "refresh_token") {
        if (this.rejectRefresh || form.get("refresh_token") !== this.refreshToken) return new Response("{}", { status: 401 });
        this.refreshes++;
        return this.issue();
      }
      if (form.get("expiring") !== "1" || !form.get("subject_token")) return new Response("{}", { status: 400 });
      this.exchanges++;
      return this.issue();
    }
    if (url === `https://${SHOP}/admin/api/2026-10/graphql.json`) {
      const headers = new Headers(init?.headers);
      if (headers.get("x-shopify-access-token") !== this.accessToken) return new Response("{}", { status: 401 });
      this.graphqlCalls++;
      if (this.denyFields)
        return Response.json({
          errors: ["name", "address1", "zip"].map((f) => ({ message: `This app is not approved to use the ${f} field. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.` })),
        });
      const { variables } = JSON.parse(String(init?.body)) as { variables: { id: string } };
      const order = orders.find((o) => o.id === variables.id);
      if (!order) return Response.json({ data: { order: null } });
      const visible = this.refundsVisible.get(order.name) ?? 0;
      return Response.json({ data: { order: { ...order, refunds: (order.refunds ?? []).slice(0, visible) } } });
    }
    return new Response("not found", { status: 404 });
  };

  private issue() {
    this.accessToken = `at-${randomBytes(4).toString("hex")}`;
    this.refreshToken = `rt-${randomBytes(4).toString("hex")}`;
    return Response.json({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 3600, refresh_token_expires_in: 7776000, scope: "read_orders" });
  }
}

let now: number;
let shopify: FakeShopify;
let db: ReturnType<typeof openAppDatabase>;
let worker: Worker;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  now = Date.parse("2026-11-16T17:00:00Z");
  shopify = new FakeShopify(() => now);
  db = openAppDatabase(":memory:");
  const client = new ShopifyClient({ apiKey: API_KEY, secret: SECRET, cipher: new TokenCipher(randomBytes(32).toString("base64")), db, fetch: shopify.fetch, now: () => now });
  worker = new Worker(db, client, () => now, undefined, new Cipher(randomBytes(32)).derive("documents"));
  app = buildApp({ apiKey: API_KEY, secret: SECRET, db, shopify: client, worker, now: () => now });
});

function idToken(overrides: Record<string, unknown> = {}, secret = SECRET) {
  const s = Math.floor(now / 1000);
  return signIdToken({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: "42", exp: s + 60, nbf: s - 1, iat: s - 1, jti: "x", sid: "y", ...overrides }, secret);
}

let deliveries = 0;
async function webhook(topic: string, payload: object, opts: { id?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", opts.secret ?? SECRET).update(body).digest("base64");
  return app.inject({
    method: "POST",
    url: "/webhooks",
    headers: { "content-type": "application/json", "x-shopify-hmac-sha256": hmac, "x-shopify-topic": topic, "x-shopify-shop-domain": SHOP, "x-shopify-webhook-id": opts.id ?? `wh-${++deliveries}` },
    payload: body,
  });
}

const api = (method: "GET" | "PUT" | "POST", url: string, payload?: object, token = idToken()) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

const orderId = (name: string) => Number(byName(name).legacyResourceId);
const refundId = (name: string, i: number) => Number(byName(name).refunds![i]!.legacyResourceId);
const settings = { name: "Tienda Prueba Einvoice SL", taxId: "A28015865", line1: "Gran Vía 1", city: "Madrid", postalCode: "28013", acceptTerms: true };

async function openApp() {
  const res = await api("GET", "/api/overview");
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("webhooks", () => {
  it("rejects deliveries without Shopify's signature and saves nothing", async () => {
    const res = await webhook(TOPICS.orderPaid, { id: 1 }, { secret: "wrong" });
    expect(res.statusCode).toBe(401);
    const n = db.prepare("select count(*) as n from inbox").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("rejects unsigned compliance requests with 401 and records signed ones", async () => {
    expect((await webhook("customers/redact", { shop_domain: SHOP }, { secret: "wrong" })).statusCode).toBe(401);
    expect((await webhook("shop/redact", { shop_domain: SHOP })).statusCode).toBe(200);
    await worker.drain();
    const rows = db.prepare("select topic from compliance_requests").all() as { topic: string }[];
    expect(rows.map((r) => r.topic)).toEqual(["shop/redact"]);
  });

  it("handles the same delivery once, however often it arrives", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    for (let i = 0; i < 3; i++) expect((await webhook(TOPICS.orderPaid, { id: orderId("#1003") }, { id: "same" })).statusCode).toBe(200);
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") }); // a new delivery of the same order
    await worker.drain();
    const o = await openApp();
    expect(o.documents.filter((d: { reference: string }) => d.reference === "#1003")).toHaveLength(1);
  });
});

describe("the admin page's API", () => {
  it.each([
    ["no token", ""],
    ["a token for another app", idToken({ aud: "someone-else" })],
    ["an expired token", idToken({ exp: Math.floor(Date.parse("2026-11-16T16:00:00Z") / 1000) })],
    ["a token signed with another secret", idToken({}, "not-the-secret")],
    ["a token whose issuer and destination differ", idToken({ iss: "https://other.myshopify.com/admin" })],
  ])("rejects %s", async (_why, token) => {
    const res = await api("GET", "/api/overview", undefined, token);
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-shopify-retry-invalid-session-request"]).toBe("1");
    expect(shopify.exchanges).toBe(0);
  });

  it("gets an access token on first use and keeps it encrypted", async () => {
    await openApp();
    await openApp();
    expect(shopify.exchanges).toBe(1);
    const row = db.prepare("select access_token, refresh_token from shops where shop = ?").get(SHOP) as { access_token: string; refresh_token: string };
    expect(row.access_token).not.toContain(shopify.accessToken);
    expect(row.refresh_token).not.toContain(shopify.refreshToken);
  });

  it("asks a shop to accept the terms once, and records when", async () => {
    await openApp();
    const { acceptTerms: _, ...withoutTerms } = settings;
    const refused = await api("PUT", "/api/settings", withoutTerms);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors).toEqual({ acceptTerms: "required" });
    expect((await openApp()).terms.accepted).toBe(false);

    expect((await api("PUT", "/api/settings", settings)).statusCode).toBe(200);
    const row = db.prepare("select version, accepted_at from agreements where shop = ?").get(SHOP) as { version: number; accepted_at: string };
    expect(row).toEqual({ version: 1, accepted_at: "2026-11-16T17:00:00.000Z" });
    // Later saves don't ask again.
    expect((await api("PUT", "/api/settings", withoutTerms)).statusCode).toBe(200);
    expect((await openApp()).terms).toMatchObject({ accepted: true, version: 1 });
  });

  it("refuses a seller tax ID with a typo", async () => {
    await openApp();
    const res = await api("PUT", "/api/settings", { ...settings, taxId: "A28015866" });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual({ taxId: "check" });
  });
});

describe("from Shopify notification to invoice", () => {
  it("holds orders until the shop's details are in, then issues everything matching Shopify", async () => {
    await openApp();
    for (const name of ["#1003", "#1001", "#1004", "#1002"]) await webhook(TOPICS.orderPaid, { id: orderId(name) });
    await worker.drain();
    let o = await openApp();
    expect(o.issued).toBe(0);
    expect(o.held).toHaveLength(4);
    expect(o.held[0].issues.join(" ")).toContain("NIF del vendedor");

    await api("PUT", "/api/settings", settings);
    await worker.drain();
    o = await openApp();
    const issued = Object.fromEntries(o.documents.map((d: { reference: string; total: number; number: string }) => [d.reference, d]));
    for (const name of ["#1003", "#1001", "#1004"]) expect(issued[name].total).toBe(toCents(byName(name).totalPriceSet.shopMoney.amount));
    // Over €3,000 with no customer tax ID: still held, for the right reason.
    expect(o.held.map((h: { reference: string }) => h.reference)).toEqual(["#1002"]);
    expect(o.held[0].issues.join(" ")).toContain("3.000");

    // Refunds, one notification each, as Shopify sends them.
    for (const [name, count] of [["#1001", 3], ["#1004", 1]] as const)
      for (let i = 0; i < count; i++) {
        shopify.refundsVisible.set(name, i + 1);
        await webhook(TOPICS.refundCreated, { id: refundId(name, i), order_id: orderId(name) });
        await worker.drain();
      }
    o = await openApp();
    const credits = o.documents.filter((d: { kind: string }) => d.kind === "credit-note");
    expect(credits.map((d: { number: string; total: number }) => [d.number, d.total]).sort()).toEqual([
      ["R2026-000001", -995],
      ["R2026-000002", -995],
      ["R2026-000003", -995],
      ["R2026-000004", -3821],
    ]);
    expect(o.chain).toEqual({ ok: true });
    expect(o.failedEvents).toBe(0);

    const pdf = await api("GET", `/api/documents/${encodeURIComponent(`order:${orderId("#1003")}`)}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("ignores order updates unless that order is on hold", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    const calls = shopify.graphqlCalls;
    await webhook(TOPICS.orderUpdated, { id: orderId("#1003") });
    await worker.drain();
    expect(shopify.graphqlCalls).toBe(calls);
  });

  it("issues a refund's invoice first when the refund is the first notification to arrive", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    shopify.refundsVisible.set("#1004", 1);
    await webhook(TOPICS.refundCreated, { id: refundId("#1004", 0), order_id: orderId("#1004") });
    await worker.drain();
    const o = await openApp();
    expect(o.documents.map((d: { number: string }) => d.number).sort()).toEqual(["F2026-000001", "R2026-000001"]);
  });
});

/** Reads a ZIP's entries and checks each one's checksum. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16), size = zip.readUInt32LE(at + 24), nameLen = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    expect(crc32(data), name).toBe(crc);
    files.set(name, data);
    at += 46 + nameLen;
  }
  return files;
}

describe("downloading everything", () => {
  it("gives a ZIP with every invoice as a PDF, a spreadsheet and the Verifactu records", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    for (const name of ["#1003", "#1004"]) await webhook(TOPICS.orderPaid, { id: orderId(name) });
    shopify.refundsVisible.set("#1004", 1);
    await webhook(TOPICS.refundCreated, { id: refundId("#1004", 0), order_id: orderId("#1004") });
    await worker.drain();

    const res = await api("GET", "/api/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain("facturas-einvoice-test-es-2026-11-16.zip");
    const files = readZip(res.rawPayload);
    expect([...files.keys()].sort()).toEqual(["LEEME.txt", "facturas.csv", "pdf/F2026-000001.pdf", "pdf/F2026-000002.pdf", "pdf/R2026-000001.pdf", "verifactu.json"]);
    for (const [name, data] of files) if (name.endsWith(".pdf")) expect(data.subarray(0, 5).toString(), name).toBe("%PDF-");

    const csv = files.get("facturas.csv")!.toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("Número;Tipo;Fecha;Fecha de operación;Pedido;Cliente;NIF del cliente;Base;IVA;Total;Moneda;Rectifica");
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.startsWith("F2026-000001"))).toBe("F2026-000001;F1;2026-11-16;;#1003;Cliente Prueba;89890001K;65,91;13,84;79,75;EUR;");
    expect(lines.find((l) => l.startsWith("R2026-000001"))).toContain(";-38,21;EUR;F2026-000002");

    const ledger = JSON.parse(files.get("verifactu.json")!.toString("utf8"));
    expect(await verifyChain(ledger)).toEqual({ ok: true });
  });
});

describe("what the app keeps", () => {
  it("encrypts waiting notifications and empties them once handled", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    shopify.down = true;
    await webhook(TOPICS.orderPaid, { id: orderId("#1003"), email: "cliente@example.com" });
    await worker.drain(); // the first attempt fails while Shopify is down
    const waiting = db.prepare("select payload from inbox where topic = ?").get(TOPICS.orderPaid) as { payload: string };
    expect(waiting.payload.startsWith("enc1:")).toBe(true);
    expect(waiting.payload).not.toContain("cliente@example.com");
    shopify.down = false;
    now += 60_000;
    await worker.drain();
    const done = db.prepare("select status, payload from inbox where topic = ?").get(TOPICS.orderPaid) as { status: string; payload: string };
    expect(done).toEqual({ status: "done", payload: "" });
  });

  it("forgets handled notifications after 30 days", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    now += 29 * 24 * 3600_000;
    expect(worker.purge()).toBe(0);
    now += 2 * 24 * 3600_000;
    expect(worker.purge()).toBeGreaterThan(0);
    const n = db.prepare("select count(*) as n from inbox where topic = ?").get(TOPICS.orderPaid) as { n: number };
    expect(n.n).toBe(0);
    expect((await openApp()).issued).toBe(1); // the invoice itself stays
  });

  it("deletes everything about a shop when Shopify asks, and nothing of other shops", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    db.prepare("insert into settings (shop, json, updated_at) values ('other.myshopify.com', '{}', 'x')").run();

    await webhook("shop/redact", { shop_domain: SHOP });
    await worker.drain();
    for (const table of ["documents", "ledger", "series", "held", "skipped", "waiting_refunds", "settings", "agreements", "shops"]) {
      const n = db.prepare(`select count(*) as n from ${table} where shop = ?`).get(SHOP) as { n: number };
      expect(n.n, table).toBe(0);
    }
    const other = db.prepare("select count(*) as n from settings where shop = 'other.myshopify.com'").get() as { n: number };
    expect(other.n).toBe(1);
  });

  it("logs customer privacy requests with the orders only, not the customer's details", async () => {
    await webhook("customers/data_request", { shop_domain: SHOP, customer: { id: 1, email: "cliente@example.com", phone: "+34600000000" }, orders_requested: [7, 8] });
    await worker.drain();
    const row = db.prepare("select payload from compliance_requests").get() as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ orders: [7, 8] });
  });
});

describe("when things go wrong", () => {
  it("says which customer details Shopify refused, and issues the invoice right after the fix", async () => {
    // What happened on the first run on a real store: name and address fields not approved yet.
    await openApp();
    await api("PUT", "/api/settings", settings);
    shopify.denyFields = true;
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    let o = await openApp();
    expect(o.issued).toBe(0);
    expect(o.missingAccess).toEqual(["name", "address1", "zip"]);

    // The merchant approves the fields and presses "Try again": no waiting for the next retry.
    shopify.denyFields = false;
    expect((await api("POST", "/api/retry")).statusCode).toBe(200);
    await worker.drain();
    o = await openApp();
    expect(o.issued).toBe(1);
    expect(o.missingAccess).toEqual([]);
  });

  it("keeps ID tokens and signatures out of the request log", () => {
    expect(logSerializers.req({ method: "GET", url: "/?embedded=1&id_token=eyJ.secret.sig&hmac=abc&shop=x.myshopify.com" })).toEqual({ method: "GET", url: "/" });
  });

  it("retries later when Shopify is down, and loses nothing", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    shopify.down = true;
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    const row = db.prepare("select status, attempts, next_attempt_at from inbox where topic = ?").get(TOPICS.orderPaid) as { status: string; attempts: number; next_attempt_at: number };
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.next_attempt_at).toBeGreaterThan(now);

    shopify.down = false;
    await worker.drain(); // not due yet
    expect((await openApp()).issued).toBe(0);
    now += 60_000;
    await worker.drain();
    expect((await openApp()).issued).toBe(1);
  });

  it("refreshes the access token before it expires", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    now += 3600_000 - 60_000; // a minute before expiry
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    expect(shopify.refreshes).toBe(1);
    expect((await openApp()).issued).toBe(1);
  });

  it("waits for the merchant when Shopify refuses the refresh, then carries on", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    now += 3600_000;
    shopify.rejectRefresh = true;
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await worker.drain();
    const row = db.prepare("select status, last_error from inbox where topic = ?").get(TOPICS.orderPaid) as { status: string; last_error: string };
    expect(row.status).toBe("pending");

    // The merchant opens the app: a new token exchange, and the order goes out on the next pass.
    shopify.rejectRefresh = false;
    await openApp();
    now += 60 * 60_000;
    await worker.drain();
    expect((await openApp()).issued).toBe(1);
  });

  it("forgets the access token when the app is uninstalled, and keeps the invoices", async () => {
    await openApp();
    await api("PUT", "/api/settings", settings);
    await webhook(TOPICS.orderPaid, { id: orderId("#1003") });
    await webhook(TOPICS.uninstalled, { id: 1 });
    await worker.drain();
    const row = db.prepare("select access_token, uninstalled_at from shops where shop = ?").get(SHOP) as { access_token: string | null; uninstalled_at: string | null };
    expect(row.access_token).toBeNull();
    expect(row.uninstalled_at).not.toBeNull();
    const docs = db.prepare("select count(*) as n from documents where shop = ?").get(SHOP) as { n: number };
    expect(docs.n).toBe(1);
    expect(await verifyChain(worker.service(SHOP).store.ledger())).toEqual({ ok: true });
  });
});
