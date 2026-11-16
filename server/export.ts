import type { DocumentStore } from "../src/store.js";
import { renderInvoicePdf } from "../src/pdf.js";
import { invoiceType } from "../src/es/verifactu.js";
import { makeZip, type ZipEntry } from "./zip.js";

const amount = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
const cell = (value: string) => {
  const safe = /^[=+\-@]/.test(value) && !/^-?\d/.test(value) ? `'${value}` : value;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const README = `Copia de tus facturas
=====================

facturas.csv          Una fila por factura y rectificativa. Separada por punto y
                      coma, con coma decimal, para abrirla en Excel en español.
pdf/                  Cada factura en PDF.
verifactu.json        Los registros Verifactu encadenados, en orden.

Guárdala en un lugar seguro. Tienes la obligación legal de conservar tus
facturas, y la app no garantiza guardarlas por ti: si la desinstalas, todo se
borra a las 48 horas.
`;

/** Everything a shop has issued: PDFs, a spreadsheet and the Verifactu records. */
export async function exportShop(store: DocumentStore, now = new Date()): Promise<Buffer> {
  const docs = store.allDocuments();
  const header = ["Número", "Tipo", "Fecha", "Fecha de operación", "Pedido", "Cliente", "NIF del cliente", "Base", "IVA", "Total", "Moneda", "Rectifica"];
  const rows = docs.map((d) =>
    [
      d.invoice.number,
      invoiceType(d.invoice),
      d.invoice.issueDate,
      d.invoice.operationDate ?? "",
      d.invoice.reference ?? "",
      d.invoice.buyer?.name ?? "",
      d.invoice.buyer?.taxId ?? "",
      amount(d.totals.base),
      amount(d.totals.tax),
      amount(d.totals.total),
      d.invoice.currency,
      d.invoice.corrects?.number ?? "",
    ].map(cell).join(";"),
  );
  // The byte order mark tells Excel the file is UTF-8, so accents show correctly.
  const csv = "﻿" + [header.join(";"), ...rows].join("\r\n") + "\r\n";

  const entries: ZipEntry[] = [
    { name: "LEEME.txt", data: Buffer.from(README, "utf8") },
    { name: "facturas.csv", data: Buffer.from(csv, "utf8") },
    { name: "verifactu.json", data: Buffer.from(JSON.stringify(store.ledger(), null, 1), "utf8") },
  ];
  for (const d of docs) entries.push({ name: `pdf/${d.invoice.number}.pdf`, data: Buffer.from(await renderInvoicePdf(d.invoice, { lang: "es" })) });
  return makeZip(entries, now);
}
