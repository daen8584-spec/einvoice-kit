import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { computeTotals, lineAmount, type Invoice, type Party } from "./invoice.js";
import { formatMoney, formatRate } from "./money.js";

export type Lang = "es" | "en";

const LABELS = {
  es: {
    invoice: "Factura", simplified: "Factura simplificada", credit: "Factura rectificativa",
    number: "Número", date: "Fecha", saleDate: "Fecha de operación", order: "Pedido", seller: "Vendedor", buyer: "Cliente",
    description: "Descripción", qty: "Cant.", price: "Precio", vat: "IVA", amount: "Importe",
    discount: "Descuento", base: "Base imponible", tax: "Cuota", total: "Total", corrects: "Rectifica la factura",
    reason: "Motivo", inclusive: "Precios con IVA incluido", exempt: "Exención",
    qrNote: "Factura verificable en la sede electrónica de la AEAT",
  },
  en: {
    invoice: "Invoice", simplified: "Simplified invoice", credit: "Credit note",
    number: "Number", date: "Date", saleDate: "Date of sale", order: "Order", seller: "Seller", buyer: "Customer",
    description: "Description", qty: "Qty", price: "Price", vat: "VAT", amount: "Amount",
    discount: "Discount", base: "Taxable base", tax: "Tax", total: "Total", corrects: "Corrects invoice",
    reason: "Reason", inclusive: "Prices include VAT", exempt: "Exemption",
    qrNote: "Invoice verifiable on the AEAT website",
  },
} as const;

/** The standard PDF fonts only cover Western European characters. */
function safe(text: string): string {
  return text.replace(/\u2212/g, "-").replace(/[^\x20-\x7E -ÿ€‘’“”–—•]/g, "?");
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

function drawQr(page: PDFPage, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++)
      if (qr.modules.get(row, col))
        page.drawRectangle({ x: x + col * cell, y: y + size - (row + 1) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
}

export interface PdfOptions {
  lang?: Lang;
  /** Verifactu (or other) verification link to print as a QR code. */
  qr?: string;
}

export async function renderInvoicePdf(invoice: Invoice, options: PdfOptions = {}): Promise<Uint8Array> {
  const L = LABELS[options.lang ?? "es"];
  const locale = options.lang === "en" ? "en-GB" : "es-ES";
  const money = (c: number) => formatMoney(c, invoice.currency, locale);
  const totals = computeTotals(invoice);

  const doc = await PDFDocument.create();
  doc.setTitle(`${invoice.number}`);
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.14);
  const grey = rgb(0.4, 0.43, 0.47);
  const M = 48;
  const W = page.getWidth() - 2 * M;
  let y = page.getHeight() - M;

  const text = (s: string, x: number, yy: number, size = 10, f = font, color = ink) =>
    page.drawText(safe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, xr: number, yy: number, size = 10, f = font) =>
    text(s, xr - f.widthOfTextAtSize(safe(s), size), yy, size, f);

  const title = invoice.kind === "credit-note" ? L.credit : invoice.buyer?.taxId ? L.invoice : L.simplified;
  text(title, M, y - 18, 20, bold);
  right(`${L.number}: ${invoice.number}`, M + W, y - 6, 10, bold);
  right(`${L.date}: ${invoice.issueDate.split("-").reverse().join("/")}`, M + W, y - 20);
  let headY = y - 34;
  if (invoice.operationDate) { right(`${L.saleDate}: ${invoice.operationDate.split("-").reverse().join("/")}`, M + W, headY); headY -= 14; }
  if (invoice.reference) right(`${L.order}: ${invoice.reference}`, M + W, headY);
  y -= 64;

  const party = (label: string, p: Party | undefined, x: number) => {
    let yy = y;
    text(label.toUpperCase(), x, yy, 8, bold, grey);
    if (!p) return yy;
    yy -= 14; text(p.name, x, yy, 10, bold);
    if (p.taxId) { yy -= 13; text(`NIF: ${p.taxId}`, x, yy); }
    const a = p.address;
    if (a?.line1) { yy -= 13; text(a.line1, x, yy); }
    const cityLine = [a?.postalCode, a?.city, a?.country].filter(Boolean).join(" ");
    if (cityLine) { yy -= 13; text(cityLine, x, yy); }
    return yy;
  };
  const bottom = Math.min(party(L.seller, invoice.seller, M), party(L.buyer, invoice.buyer, M + W / 2));
  y = bottom - 28;

  if (invoice.corrects) {
    text(`${L.corrects} ${invoice.corrects.number} (${invoice.corrects.issueDate.split("-").reverse().join("/")}). ${L.reason}: ${invoice.corrects.reason}`, M, y, 9);
    y -= 22;
  }

  const cols = { desc: M, qty: M + W * 0.58, price: M + W * 0.72, vat: M + W * 0.82, amount: M + W };
  page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + W, y: y + 4 }, thickness: 0.5, color: grey });
  y -= 10;
  text(L.description, cols.desc, y, 8, bold, grey);
  right(L.qty, cols.qty, y, 8, bold); right(L.price, cols.price, y, 8, bold);
  right(L.vat, cols.vat, y, 8, bold); right(L.amount, cols.amount, y, 8, bold);
  y -= 16;

  for (const line of invoice.lines) {
    if (y < 200) break;
    text(fit(line.description, font, 10, W * 0.5), cols.desc, y);
    right(String(line.quantity), cols.qty, y);
    right(money(line.unitPrice), cols.price, y);
    right(formatRate(line.rate), cols.vat, y);
    right(money(lineAmount(line)), cols.amount, y);
    if (line.discount) { y -= 12; text(fit(`  ${L.discount}: -${money(Math.abs(line.discount))}`, font, 8, W * 0.5), cols.desc, y, 8, font, grey); }
    if (line.exemption) { y -= 12; text(fit(`  ${L.exempt}: ${line.exemption}`, font, 8, W * 0.55), cols.desc, y, 8, font, grey); }
    y -= 16;
  }
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: M + W, y: y + 6 }, thickness: 0.5, color: grey });
  y -= 14;

  const labelX = M + W * 0.55;
  for (const g of totals.groups) {
    text(`${L.base} ${formatRate(g.rate)}`, labelX, y, 9, font, grey); right(money(g.base), cols.amount, y, 9); y -= 13;
    text(`${L.tax} ${formatRate(g.rate)}`, labelX, y, 9, font, grey); right(money(g.tax), cols.amount, y, 9); y -= 13;
  }
  y -= 4;
  text(L.total, labelX, y, 13, bold); right(money(totals.total), cols.amount, y, 13, bold);
  if (invoice.pricesIncludeTax) { y -= 14; text(L.inclusive, labelX, y, 8, font, grey); }

  if (options.qr) {
    const size = 96;
    drawQr(page, options.qr, M, M + 14, size);
    text("VERI*FACTU", M, M + 4, 8, bold);
    text(L.qrNote, M + size + 12, M + 14 + size / 2, 8, font, grey);
  }
  return doc.save();
}
