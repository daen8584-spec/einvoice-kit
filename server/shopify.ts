import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync as Database } from "node:sqlite";
import type { GraphQLOrder } from "../src/shopify/from-graphql.js";

export const API_VERSION = "2026-10";

export type Fetch = typeof fetch;

/** Webhooks: base64 HMAC-SHA256 of the raw body, keyed with the app's client secret. */
export function verifyWebhook(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Builds an ID token the way Shopify does. Used by the tests, never by the app. */
export function signIdToken(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export class Unauthorized extends Error {}

/**
 * Checks the ID token App Bridge sends with every request from the admin: signed
 * with the client secret, meant for this app, current, and issued and addressed
 * by the same shop. Returns that shop's myshopify.com domain.
 */
export function verifyIdToken(token: string, apiKey: string, secret: string, now = Date.now()): { shop: string; sub?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Unauthorized("malformed token");
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Unauthorized("bad signature");

  let header: { alg?: string };
  let claims: { exp?: number; nbf?: number; aud?: string; iss?: string; dest?: string; sub?: string };
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString());
    claims = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new Unauthorized("malformed token");
  }
  if (header.alg !== "HS256") throw new Unauthorized("unexpected algorithm");
  const seconds = Math.floor(now / 1000);
  const leeway = 5;
  if (typeof claims.exp !== "number" || claims.exp + leeway <= seconds) throw new Unauthorized("expired");
  if (typeof claims.nbf !== "number" || claims.nbf - leeway > seconds) throw new Unauthorized("not valid yet");
  if (claims.aud !== apiKey) throw new Unauthorized("token is for another app");

  let iss: URL, dest: URL;
  try {
    iss = new URL(String(claims.iss));
    dest = new URL(String(claims.dest));
  } catch {
    throw new Unauthorized("bad issuer or destination");
  }
  if (iss.hostname !== dest.hostname || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dest.hostname))
    throw new Unauthorized("issuer and destination don't match");
  return claims.sub ? { shop: dest.hostname, sub: claims.sub } : { shop: dest.hostname };
}

/** Access tokens are encrypted at rest with AES-256-GCM. */
export class TokenCipher {
  private readonly key: Buffer;
  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
  }
  open(sealed: string): string {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  }
}

export class ShopifyUnavailable extends Error {}
export class ReauthorizeNeeded extends Error {}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface ShopifyClientOptions {
  apiKey: string;
  secret: string;
  cipher: TokenCipher;
  db: Database;
  fetch?: Fetch;
  now?: () => number;
}

/**
 * Offline access tokens per shop: obtained by token exchange when a merchant
 * opens the app, renewed with the refresh token before they expire, and used for
 * Admin GraphQL calls from webhooks and background work.
 */
export class ShopifyClient {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly o: ShopifyClientOptions) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  hasToken(shop: string): boolean {
    const row = this.o.db.prepare("select access_token from shops where shop = ? and uninstalled_at is null").get(shop) as { access_token?: string } | undefined;
    return Boolean(row?.access_token);
  }

  /** Token exchange with the merchant's ID token, asking for an expiring offline token. */
  async exchange(shop: string, idToken: string): Promise<void> {
    const res = await this.post(shop, {
      client_id: this.o.apiKey,
      client_secret: this.o.secret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    });
    if (res.status === 400) throw new Unauthorized("ID token rejected by Shopify");
    if (!res.ok) throw new ShopifyUnavailable(`token exchange failed: ${res.status}`);
    this.save(shop, (await res.json()) as TokenResponse);
  }

  /** A valid access token, refreshed first if it expires within five minutes. */
  async accessToken(shop: string): Promise<string> {
    const row = this.o.db.prepare("select * from shops where shop = ? and uninstalled_at is null").get(shop) as
      | { access_token: string; expires_at: number | null; refresh_token: string | null }
      | undefined;
    if (!row?.access_token) throw new ReauthorizeNeeded(`no access token for ${shop}`);
    if (row.expires_at === null || row.expires_at - this.now() > 5 * 60_000) return this.o.cipher.open(row.access_token);
    if (!row.refresh_token) throw new ReauthorizeNeeded(`no refresh token for ${shop}`);

    // One refresh at a time per shop: a refresh token is replaced when used.
    const running = this.refreshing.get(shop);
    if (running) return running;
    const job = this.refresh(shop, this.o.cipher.open(row.refresh_token)).finally(() => this.refreshing.delete(shop));
    this.refreshing.set(shop, job);
    return job;
  }

  private async refresh(shop: string, refreshToken: string): Promise<string> {
    const res = await this.post(shop, { client_id: this.o.apiKey, client_secret: this.o.secret, grant_type: "refresh_token", refresh_token: refreshToken });
    if (res.status === 401 || res.status === 400) {
      this.o.db.prepare("update shops set access_token = null, refresh_token = null where shop = ?").run(shop);
      throw new ReauthorizeNeeded(`refresh rejected for ${shop}`);
    }
    if (!res.ok) throw new ShopifyUnavailable(`token refresh failed: ${res.status}`);
    const body = (await res.json()) as TokenResponse;
    this.save(shop, body);
    return body.access_token;
  }

  private save(shop: string, t: TokenResponse): void {
    const now = this.now();
    this.o.db
      .prepare(
        `insert into shops (shop, access_token, refresh_token, expires_at, refresh_expires_at, scope, installed_at, uninstalled_at)
         values (?, ?, ?, ?, ?, ?, ?, null)
         on conflict (shop) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at, scope = excluded.scope, uninstalled_at = null`,
      )
      .run(
        shop,
        this.o.cipher.seal(t.access_token),
        t.refresh_token ? this.o.cipher.seal(t.refresh_token) : null,
        t.expires_in ? now + t.expires_in * 1000 : null,
        t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
        t.scope ?? null,
        new Date(now).toISOString(),
      );
  }

  forget(shop: string): void {
    this.o.db.prepare("update shops set access_token = null, refresh_token = null, uninstalled_at = ? where shop = ?").run(new Date(this.now()).toISOString(), shop);
  }

  private async post(shop: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
    } catch (error) {
      throw new ShopifyUnavailable(`can't reach ${shop}: ${String(error)}`);
    }
  }

  /** An Admin GraphQL call. Throttling and outages become ShopifyUnavailable, to be retried later. */
  async graphql<T>(shop: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this.accessToken(shop);
    let res: Response;
    try {
      res = await this.fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": token },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new ShopifyUnavailable(`can't reach ${shop}: ${String(error)}`);
    }
    if (res.status === 401) {
      this.o.db.prepare("update shops set expires_at = 0 where shop = ?").run(shop);
      throw new ShopifyUnavailable("access token rejected; it will be refreshed");
    }
    if (res.status === 429 || res.status >= 500) throw new ShopifyUnavailable(`Shopify answered ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (body.errors?.length) {
      if (body.errors.some((e) => e.extensions?.code === "THROTTLED")) throw new ShopifyUnavailable("throttled");
      throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data as T;
  }

  /** The order with everything invoicing needs, in the shape from-graphql expects. */
  async fetchOrder(shop: string, id: number): Promise<GraphQLOrder | null> {
    const data = await this.graphql<{ order: GraphQLOrder | null }>(shop, ORDER_QUERY, { id: `gid://shopify/Order/${id}` });
    return data.order;
  }
}

const MONEY = "shopMoney { amount }";
export const ORDER_QUERY = `query Order($id: ID!) { order(id: $id) {
  id legacyResourceId name createdAt processedAt currencyCode taxesIncluded
  totalPriceSet { ${MONEY} } totalTaxSet { ${MONEY} }
  customAttributes { key value }
  billingAddress { name company address1 city zip countryCodeV2 }
  lineItems(first: 250) { nodes { id title variantTitle quantity
    originalUnitPriceSet { ${MONEY} }
    discountAllocations { allocatedAmountSet { ${MONEY} } }
    taxLines { title rate priceSet { ${MONEY} } } } }
  shippingLines(first: 20) { nodes { title originalPriceSet { ${MONEY} }
    discountAllocations { allocatedAmountSet { ${MONEY} } }
    taxLines { title rate priceSet { ${MONEY} } } } }
  refunds { legacyResourceId createdAt note
    refundLineItems(first: 250) { nodes { quantity lineItem { id } subtotalSet { ${MONEY} } totalTaxSet { ${MONEY} } } }
    orderAdjustments(first: 20) { nodes { reason amountSet { ${MONEY} } taxAmountSet { ${MONEY} } } } }
} }`;
