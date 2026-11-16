import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { DatabaseSync as Database } from "node:sqlite";
import { verifyChain } from "../src/es/verify.js";
import { validateTaxId } from "../src/es/nif.js";
import { renderInvoicePdf, type Lang } from "../src/pdf.js";
import type { ShopSettings } from "../src/shopify/to-invoice.js";
import { acceptTerms, LEGAL_URL, loadSettings, saveSettings, termsAccepted, TERMS_VERSION } from "./db.js";
import { exportShop } from "./export.js";
import { ShopifyClient, ShopifyUnavailable, Unauthorized, verifyIdToken, verifyWebhook } from "./shopify.js";
import { renderAppPage } from "./ui.js";
import { COMPLIANCE_TOPICS, TOPICS, Worker } from "./worker.js";

export interface AppOptions {
  apiKey: string;
  secret: string;
  db: Database;
  shopify: ShopifyClient;
  worker: Worker;
  now?: () => number;
  logger?: boolean;
}

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

declare module "fastify" {
  interface FastifyRequest {
    shop?: string;
  }
}

/**
 * Request logs without query strings: Shopify puts a short-lived ID token and an
 * HMAC in the admin page's address, and neither belongs in a log.
 */
export const logSerializers = {
  req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split("?")[0] ?? "" }),
};

export function buildApp(o: AppOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ? { serializers: logSerializers } : false, bodyLimit: 2 * 1024 * 1024 });
  const now = o.now ?? Date.now;

  app.get("/health", async () => ({ ok: true }));

  // The admin page. Shopify shows it inside the admin, so only the shop's admin
  // may frame it.
  app.get("/", async (req, reply) => {
    const shop = String((req.query as Record<string, string>).shop ?? "");
    const ancestors = SHOP.test(shop) ? `https://${shop} https://admin.shopify.com` : "https://admin.shopify.com";
    reply
      .header("content-security-policy", `frame-ancestors ${ancestors};`)
      .header("x-content-type-options", "nosniff")
      .type("text/html; charset=utf-8");
    return renderAppPage(o.apiKey);
  });

  // Webhooks: check they come from Shopify, save them, answer straight away, and
  // process them afterwards. Shopify gives up on deliveries slower than 5 seconds.
  app.register(async (hooks) => {
    // The signature covers the exact bytes Shopify sent, so nothing may parse them first.
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    hooks.post("/webhooks", async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, req.headers["x-shopify-hmac-sha256"] as string | undefined, o.secret))
        return reply.code(401).send({ error: "invalid signature" });
      const topic = String(req.headers["x-shopify-topic"] ?? "");
      const shop = String(req.headers["x-shopify-shop-domain"] ?? "");
      const id = String(req.headers["x-shopify-webhook-id"] ?? "");
      if (!topic || !id || !SHOP.test(shop)) return reply.code(400).send({ error: "missing headers" });
      const known = [...Object.values(TOPICS), ...COMPLIANCE_TOPICS].includes(topic as never);
      if (known) {
        o.worker.enqueue(id, shop, topic, raw.toString("utf8"));
        void o.worker.drain();
      }
      return reply.code(200).send({ ok: true });
    });
  });

  // The admin page's API. Every request carries an ID token from App Bridge.
  app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      try {
        const { shop } = verifyIdToken(token, o.apiKey, o.secret, now());
        if (!o.shopify.hasToken(shop)) await o.shopify.exchange(shop, token);
        req.shop = shop;
      } catch (error) {
        if (error instanceof Unauthorized) return reply.header("x-shopify-retry-invalid-session-request", "1").code(401).send({ error: "unauthorized" });
        if (error instanceof ShopifyUnavailable) return reply.code(503).send({ error: "Shopify is unavailable, try again" });
        throw error;
      }
    });

    api.get("/api/overview", async (req) => {
      const shop = req.shop!;
      const lang: Lang = (req.query as Record<string, string>).lang === "en" ? "en" : "es";
      const service = o.worker.service(shop);
      const docs = service.store.allDocuments();
      const held = service.store.allHeld();
      const failed = o.db.prepare("select count(*) as n from inbox where shop = ? and status = 'failed'").get(shop) as { n: number };
      const waiting = o.db.prepare("select count(*) as n from inbox where shop = ? and status = 'pending'").get(shop) as { n: number };
      return {
        settings: loadSettings(o.db, shop),
        terms: { accepted: termsAccepted(o.db, shop), version: TERMS_VERSION, url: LEGAL_URL },
        documents: docs
          .slice(-200)
          .reverse()
          .map((d) => ({
            key: d.key,
            number: d.invoice.number,
            kind: d.invoice.kind,
            issueDate: d.invoice.issueDate,
            total: d.totals.total,
            currency: d.invoice.currency,
            reference: d.invoice.reference ?? "",
            buyer: d.invoice.buyer?.name ?? "",
          })),
        issued: docs.length,
        held: held.map((h) => ({
          key: h.key,
          reference: h.draft.reference ?? "",
          issues: h.issues.filter((i) => i.level === "error").map((i) => i[lang]),
        })),
        pendingEvents: Number(waiting.n),
        missingAccess: o.worker.missingAccess(shop),
        copies: o.worker.copyStatus(shop),
        failedEvents: Number(failed.n),
        chain: await verifyChain(service.store.ledger()),
      };
    });

    api.put("/api/settings", async (req, reply) => {
      const shop = req.shop!;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const text = (k: string) => String(b[k] ?? "").trim();
      const errors: Record<string, string> = {};
      if (!text("name")) errors.name = "required";
      const id = validateTaxId(text("taxId"));
      if (!id.valid) errors.taxId = id.reason;
      const accepted = termsAccepted(o.db, shop);
      if (!accepted && b.acceptTerms !== true) errors.acceptTerms = "required";
      if (Object.keys(errors).length) return reply.code(422).send({ errors });

      const address = Object.fromEntries(
        [["line1", text("line1")], ["city", text("city")], ["postalCode", text("postalCode")], ["country", text("country") || "ES"]].filter(([, v]) => v),
      );
      const settings: ShopSettings = {
        seller: { name: text("name"), taxId: id.valid ? id.normalized : "", address },
        timeZone: text("timeZone") === "Atlantic/Canary" ? "Atlantic/Canary" : "Europe/Madrid",
        ...(text("exemptionText") ? { exemptionText: text("exemptionText") } : {}),
      };
      saveSettings(o.db, shop, settings);
      if (!accepted) acceptTerms(o.db, shop, new Date(now()));
      // Invoices held for missing details can go out now.
      o.worker.enqueue(`retry:${shop}:${now()}`, shop, TOPICS.retryHeld, "{}");
      o.worker.retryNow(shop);
      void o.worker.drain();
      return { settings };
    });

    // After the merchant fixes something: try held invoices and waiting notifications now.
    api.post("/api/retry", async (req) => {
      o.worker.enqueue(`retry:${req.shop}:${now()}`, req.shop!, TOPICS.retryHeld, "{}");
      o.worker.retryNow(req.shop!);
      await o.worker.drain();
      return { ok: true };
    });

    // A copy of everything, for the shop to keep: the app doesn't promise to.
    api.get("/api/export", async (req, reply) => {
      const zip = await exportShop(o.worker.service(req.shop!).store, new Date(now()));
      const day = new Date(now()).toISOString().slice(0, 10);
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="facturas-${req.shop!.replace(".myshopify.com", "")}-${day}.zip"`)
        .send(zip);
    });

    api.get("/api/documents/:key/pdf", async (req, reply) => {
      const { key } = req.params as { key: string };
      const lang: Lang = (req.query as Record<string, string>).lang === "en" ? "en" : "es";
      const doc = o.worker.service(req.shop!).store.document(key);
      if (!doc) return reply.code(404).send({ error: "not found" });
      // No Verifactu QR until records are actually sent to the tax office: the QR
      // tells customers the invoice can be checked there.
      const pdf = await renderInvoicePdf(doc.invoice, { lang });
      return reply
        .type("application/pdf")
        .header("content-disposition", `attachment; filename="${doc.invoice.number}.pdf"`)
        .send(Buffer.from(pdf));
    });
  });

  return app;
}
