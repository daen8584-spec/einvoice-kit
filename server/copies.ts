import type { DatabaseSync as Database } from "node:sqlite";
import type { IssuedDocument } from "../src/store.js";
import { invoiceType } from "../src/es/verifactu.js";
import { lineAmount } from "../src/invoice.js";
import type { ShopifyClient } from "./shopify.js";

/**
 * A copy of every invoice, kept in the store's own Shopify orders.
 *
 * It goes in a merchant-owned metafield, which belongs to the store: it's private
 * to the store's admin, shows on the order page, and stays when the app is
 * uninstalled or stops running. (Shopify Files would have been simpler, but their
 * addresses are public, and invoices carry customers' names and tax IDs.)
 */
export const COPY_NAMESPACE = "einvoice_kit";
export const COPY_KEY = "facturas";
const DEFINITION_MARK = "__definition__";

const money = (cents: number) => (cents / 100).toFixed(2);

/** The invoice in plain JSON, readable without the app. */
export function copyOf(d: IssuedDocument) {
  const i = d.invoice;
  return {
    numero: i.number,
    tipo: invoiceType(i),
    clase: i.kind === "credit-note" ? "rectificativa" : "factura",
    fecha: i.issueDate,
    ...(i.operationDate ? { fecha_operacion: i.operationDate } : {}),
    ...(i.corrects ? { rectifica: { numero: i.corrects.number, fecha: i.corrects.issueDate, motivo: i.corrects.reason } } : {}),
    vendedor: i.seller,
    ...(i.buyer ? { cliente: i.buyer } : {}),
    moneda: i.currency,
    precios_con_iva: i.pricesIncludeTax,
    lineas: i.lines.map((l) => ({ descripcion: l.description, cantidad: l.quantity, precio: money(l.unitPrice), importe: money(lineAmount(l)), iva: l.rate / 100, ...(l.exemption ? { exencion: l.exemption } : {}) })),
    desglose: d.totals.groups.map((g) => ({ iva: g.rate / 100, base: money(g.base), cuota: money(g.tax) })),
    base: money(d.totals.base),
    cuota: money(d.totals.tax),
    total: money(d.totals.total),
    verifactu: { huella: d.record.fingerprint, registro: d.record.fields },
  };
}

/** The Shopify order a document belongs to: its own for invoices, the corrected invoice's for credit notes. */
export function orderIdOf(d: IssuedDocument, byNumber: Map<string, IssuedDocument>): number | null {
  if (d.key.startsWith("order:")) return Number(d.key.slice(6));
  const original = d.invoice.corrects ? byNumber.get(d.invoice.corrects.number) : undefined;
  return original ? orderIdOf(original, byNumber) : null;
}

const DEFINE = `mutation Define($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { code message } }
}`;
const SET = `mutation Save($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

/**
 * Writes the copies still missing for a shop. Each order's field holds all its
 * documents, so writing it again is harmless. Returns how many documents were saved.
 */
export async function saveCopies(db: Database, shopify: ShopifyClient, shop: string, documents: IssuedDocument[], max = 25): Promise<number> {
  const done = new Set((db.prepare("select key from copies where shop = ?").all(shop) as { key: string }[]).map((r) => r.key));
  const missing = documents.filter((d) => !done.has(d.key));
  if (!missing.length) return 0;

  if (!done.has(DEFINITION_MARK)) {
    const define = (pin: boolean) =>
      shopify.graphql<{ metafieldDefinitionCreate: { userErrors: { code: string; message: string }[] } }>(shop, DEFINE, {
        definition: {
          name: "Facturas (einvoice-kit)",
          description: "Copia de las facturas y rectificativas de este pedido, guardada en tu tienda.",
          namespace: COPY_NAMESPACE,
          key: COPY_KEY,
          type: "json",
          ownerType: "ORDER",
          pin,
        },
      });
    // Already defined, or data already there without a definition: both fine.
    const fine = new Set(["TAKEN", "UNSTRUCTURED_ALREADY_EXISTS"]);
    let errors = (await define(true)).metafieldDefinitionCreate.userErrors.filter((e) => !fine.has(e.code));
    // A store can pin only so many fields; the copy matters more than the pin.
    if (errors.some((e) => e.code === "PINNED_LIMIT_REACHED" || e.code === "UNSUPPORTED_PINNING"))
      errors = (await define(false)).metafieldDefinitionCreate.userErrors.filter((e) => !fine.has(e.code));
    if (errors.length) throw new Error(`couldn't create the copies field: ${errors.map((e) => e.message).join("; ")}`);
    db.prepare("insert or ignore into copies (shop, key, saved_at) values (?, ?, ?)").run(shop, DEFINITION_MARK, new Date().toISOString());
  }

  const byNumber = new Map(documents.map((d) => [d.invoice.number, d]));
  const byOrder = new Map<number, IssuedDocument[]>();
  for (const d of documents) {
    const id = orderIdOf(d, byNumber);
    if (id !== null) byOrder.set(id, [...(byOrder.get(id) ?? []), d]);
  }
  const orders = [...new Set(missing.map((d) => orderIdOf(d, byNumber)).filter((id): id is number => id !== null))].slice(0, max);
  if (!orders.length) return 0;

  const r = await shopify.graphql<{ metafieldsSet: { userErrors: { message: string }[] } }>(shop, SET, {
    metafields: orders.map((id) => ({
      ownerId: `gid://shopify/Order/${id}`,
      namespace: COPY_NAMESPACE,
      key: COPY_KEY,
      type: "json",
      value: JSON.stringify({ app: "einvoice-kit", documentos: byOrder.get(id)!.map(copyOf) }),
    })),
  });
  if (r.metafieldsSet.userErrors.length) throw new Error(`couldn't save copies: ${r.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`);

  const saved = orders.flatMap((id) => byOrder.get(id)!);
  const insert = db.prepare("insert or ignore into copies (shop, key, saved_at) values (?, ?, ?)");
  for (const d of saved) insert.run(shop, d.key, new Date().toISOString());
  return saved.length;
}
