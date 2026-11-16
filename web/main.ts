import QRCode from "qrcode";
import { checkSpanishInvoice, type Issue } from "../src/es/check.js";
import { fingerprint, invoiceType, qrUrl, registrationFields } from "../src/es/verifactu.js";
import type { Invoice, InvoiceLine } from "../src/invoice.js";
import { formatMoney, formatRate, toCents } from "../src/money.js";

type Lang = "es" | "en";

const T: Record<Lang, Record<string, string>> = {
  es: {
    brand: "Comprobador de facturas", title: "¿Tu factura cumple en España?",
    lede: "Escribe los datos de una factura y te diremos qué falta o qué está mal: el NIF, el IVA, los totales, y si es completa o simplificada. También verás cómo quedaría con el código QR de Verifactu.",
    privacy: "Todo se comprueba en tu navegador. Tus datos no se envían a ningún sitio.",
    yourInvoice: "Tu factura", loadExample: "Cargar ejemplo", clear: "Vaciar",
    exampleNote: "Estos datos son un ejemplo. Cámbialos por los de tu factura.",
    seller: "Vendedor (tú)", buyer: "Cliente <span class=\"opt\">(opcional)</span>", name: "Nombre o razón social",
    buyerHint: "Sin el NIF del cliente, la factura es simplificada.", invoiceData: "Factura", number: "Número", date: "Fecha",
    isCredit: "Es rectificativa", correctsNumber: "Nº de la factura que corrige", correctsDate: "Fecha de esa factura", reason: "Motivo",
    lines: "Líneas", inclusive: "Los precios incluyen IVA", description: "Descripción", qty: "Cant.", price: "Precio", vat: "IVA",
    addLine: "+ Añadir línea", statedTotalLegend: "Total impreso en tu factura <span class=\"opt\">(opcional)</span>", statedTotal: "Total",
    whatToFix: "Qué revisar", totals: "Totales", fingerprint: "Huella de ejemplo",
    vfExplain: "Desde la entrada en vigor de Verifactu, cada factura lleva este QR. Al escanearlo, tu cliente puede comprobarla en la web de Hacienda.",
    downloadPdf: "Descargar PDF de ejemplo", aboutTitle: "Sobre esta herramienta",
    about1: "Revisa los requisitos básicos de una factura en España y prepara los datos que pide Verifactu: el tipo de factura, la huella encadenada y el código QR. No envía nada a la Agencia Tributaria y no sustituye a un asesor fiscal.",
    about2: "Las fechas de Verifactu han cambiado varias veces. Consulta siempre el calendario vigente en el BOE o en la web de la AEAT.",
    madeBy: "Hecho por", code: "Código", privacyLink: "Privacidad", termsLink: "Términos",
    allGood: "Todo correcto", allGoodSub: "No hemos encontrado ningún problema en los requisitos que revisamos.",
    errors: "{n} cosas que corregir", error1: "1 cosa que corregir", errorsSub: "Esta factura no cumpliría tal como está.",
    warnings: "Casi lista", warningsSub: "Revisa los avisos antes de emitirla.",
    error: "Error", warning: "Aviso", nothing: "Nada que revisar.",
    base: "Base imponible", tax: "Cuota IVA", total: "Total", type: "Tipo",
    F1: "Factura completa (F1)", F2: "Factura simplificada (F2)", R1: "Rectificativa (R1)", R5: "Rectificativa simplificada (R5)",
    exemptPh: "Motivo de la exención, p. ej. art. 20 LIVA", remove: "Quitar línea",
    badAmount: "En la línea {n}, «{v}» no es un importe válido.", badQty: "En la línea {n}, la cantidad no es un número.",
    badTotal: "El total impreso no es un importe válido.", qrAlt: "Código QR de Verifactu para esta factura",
  },
  en: {
    brand: "Invoice checker", title: "Does your invoice meet Spanish rules?",
    lede: "Enter an invoice's details and we'll tell you what's missing or wrong: the tax ID, VAT, totals, and whether it's a full or simplified invoice. You'll also see it with its Verifactu QR code.",
    privacy: "Everything is checked in your browser. Your data isn't sent anywhere.",
    yourInvoice: "Your invoice", loadExample: "Load example", clear: "Clear",
    exampleNote: "This is example data. Replace it with your invoice's details.",
    seller: "Seller (you)", buyer: "Customer <span class=\"opt\">(optional)</span>", name: "Name or company name",
    buyerHint: "Without the customer's tax ID, it's a simplified invoice.", invoiceData: "Invoice", number: "Number", date: "Date",
    isCredit: "It's a corrective invoice", correctsNumber: "Number of the invoice it corrects", correctsDate: "Date of that invoice", reason: "Reason",
    lines: "Lines", inclusive: "Prices include VAT", description: "Description", qty: "Qty", price: "Price", vat: "VAT",
    addLine: "+ Add line", statedTotalLegend: "Total printed on your invoice <span class=\"opt\">(optional)</span>", statedTotal: "Total",
    whatToFix: "What to check", totals: "Totals", fingerprint: "Example fingerprint",
    vfExplain: "Once Verifactu applies, every invoice carries this QR code. Scanning it lets your customer check the invoice on the tax office's website.",
    downloadPdf: "Download example PDF", aboutTitle: "About this tool",
    about1: "It checks the basic requirements for an invoice in Spain and prepares what Verifactu asks for: the invoice type, the chained fingerprint and the QR code. It doesn't send anything to the tax office and isn't a substitute for a tax adviser.",
    about2: "Verifactu's dates have changed several times. Always check the current schedule in the BOE or on the AEAT website.",
    madeBy: "Made by", code: "Code", privacyLink: "Privacy", termsLink: "Terms",
    allGood: "All good", allGoodSub: "We found no problems with the requirements we check.",
    errors: "{n} things to fix", error1: "1 thing to fix", errorsSub: "This invoice wouldn't be valid as it is.",
    warnings: "Almost ready", warningsSub: "Look at the warnings before issuing it.",
    error: "Error", warning: "Warning", nothing: "Nothing to check.",
    base: "Taxable base", tax: "VAT", total: "Total", type: "Type",
    F1: "Full invoice (F1)", F2: "Simplified invoice (F2)", R1: "Corrective (R1)", R5: "Simplified corrective (R5)",
    exemptPh: "Reason for the exemption, e.g. art. 20 LIVA", remove: "Remove line",
    badAmount: "On line {n}, \"{v}\" isn't a valid amount.", badQty: "On line {n}, the quantity isn't a number.",
    badTotal: "The printed total isn't a valid amount.", qrAlt: "Verifactu QR code for this invoice",
  },
};

let lang: Lang = "es";
try { if (localStorage.getItem("lang") === "en") lang = "en"; } catch { /* storage unavailable */ }
const t = (key: string, vars: Record<string, string | number> = {}) =>
  (T[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const input = (id: string) => $<HTMLInputElement>(id);

interface LineRow { description: string; quantity: string; price: string; rate: string; exemption: string }

const today = () => new Date().toISOString().slice(0, 10);
const EXAMPLE = {
  sellerName: "Tienda Ejemplo SL", sellerNif: "B12345674", buyerName: "", buyerNif: "",
  number: "F2026-000127", date: today(), inclusive: true,
  lines: [
    { description: "Camiseta de algodón", quantity: "2", price: "22,50", rate: "2100", exemption: "" },
    { description: "Libro de recetas", quantity: "1", price: "18,90", rate: "400", exemption: "" },
    { description: "Envío", quantity: "1", price: "4,95", rate: "2100", exemption: "" },
  ] as LineRow[],
};

const linesEl = $("lines");

function lineRow(row: LineRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "line";
  el.innerHTML = `
    <input class="desc" data-k="description" aria-label="${t("description")}">
    <input data-k="quantity" inputmode="decimal" aria-label="${t("qty")}">
    <input data-k="price" inputmode="decimal" placeholder="0,00" aria-label="${t("price")}">
    <select data-k="rate" aria-label="${t("vat")}"><option value="2100">21%</option><option value="1000">10%</option><option value="400">4%</option><option value="0">0%</option></select>
    <button type="button" class="icon" aria-label="${t("remove")}" title="${t("remove")}">×</button>
    <input class="exempt" data-k="exemption" placeholder="${t("exemptPh")}" aria-label="${t("exemptPh")}" hidden>`;
  for (const k of ["description", "quantity", "price", "rate", "exemption"] as const)
    (el.querySelector(`[data-k="${k}"]`) as HTMLInputElement).value = row[k];
  el.querySelector("button")!.addEventListener("click", () => { el.remove(); update(); });
  return el;
}

function readLines(): LineRow[] {
  return [...linesEl.querySelectorAll<HTMLElement>(".line")].map((el) => {
    const v = (k: string) => (el.querySelector(`[data-k="${k}"]`) as HTMLInputElement).value;
    return { description: v("description"), quantity: v("quantity"), price: v("price"), rate: v("rate"), exemption: v("exemption") };
  });
}

function fill(data: typeof EXAMPLE, isExample: boolean) {
  input("seller-name").value = data.sellerName; input("seller-nif").value = data.sellerNif;
  input("buyer-name").value = data.buyerName; input("buyer-nif").value = data.buyerNif;
  input("number").value = data.number; input("date").value = data.date;
  input("inclusive").checked = data.inclusive; input("kind").checked = false;
  for (const id of ["corrects-number", "corrects-date", "corrects-reason", "stated-total"]) input(id).value = "";
  linesEl.replaceChildren(...data.lines.map(lineRow));
  $("example-note").hidden = !isExample;
  update();
}

function build(): { invoice: Invoice; inputIssues: Issue[]; statedTotal?: number } {
  const inputIssues: Issue[] = [];
  const lines: InvoiceLine[] = [];
  readLines().forEach((row, i) => {
    const n = i + 1;
    if (!row.description.trim() && !row.price.trim()) return;
    let unitPrice = 0;
    try { unitPrice = toCents(row.price || "0"); } catch {
      inputIssues.push({ level: "error", code: "input", es: T.es.badAmount!.replace("{n}", String(n)).replace("{v}", row.price), en: T.en.badAmount!.replace("{n}", String(n)).replace("{v}", row.price) });
    }
    const quantity = Number((row.quantity || "1").replace(",", "."));
    if (!Number.isFinite(quantity))
      inputIssues.push({ level: "error", code: "input", es: T.es.badQty!.replace("{n}", String(n)), en: T.en.badQty!.replace("{n}", String(n)) });
    const line: InvoiceLine = { description: row.description, quantity: Number.isFinite(quantity) ? quantity : 0, unitPrice, rate: Number(row.rate) };
    if (row.exemption.trim()) line.exemption = row.exemption;
    lines.push(line);
  });

  const credit = input("kind").checked;
  const buyerName = input("buyer-name").value.trim();
  const buyerNif = input("buyer-nif").value.trim();
  const invoice: Invoice = {
    kind: credit ? "credit-note" : "invoice",
    number: input("number").value,
    issueDate: input("date").value,
    seller: { name: input("seller-name").value, taxId: input("seller-nif").value.trim() },
    currency: "EUR",
    pricesIncludeTax: input("inclusive").checked,
    lines,
    ...(buyerName || buyerNif ? { buyer: { name: buyerName, ...(buyerNif ? { taxId: buyerNif } : {}) } } : {}),
    ...(credit ? { corrects: { number: input("corrects-number").value, issueDate: input("corrects-date").value, reason: input("corrects-reason").value } } : {}),
  };

  let statedTotal: number | undefined;
  const st = input("stated-total").value.trim();
  if (st) {
    try { statedTotal = toCents(st); } catch {
      inputIssues.push({ level: "error", code: "input", es: T.es.badTotal!, en: T.en.badTotal! });
    }
  }
  return statedTotal === undefined ? { invoice, inputIssues } : { invoice, inputIssues, statedTotal };
}

let current: Invoice | null = null;
let renderId = 0;

async function update() {
  const id = ++renderId;
  for (const el of linesEl.querySelectorAll<HTMLElement>(".line")) {
    const zero = (el.querySelector('[data-k="rate"]') as HTMLSelectElement).value === "0";
    (el.querySelector('[data-k="exemption"]') as HTMLInputElement).hidden = !zero;
  }
  $("corrects-row").hidden = !input("kind").checked;

  const { invoice, inputIssues, statedTotal } = build();
  const { issues, totals } = checkSpanishInvoice(invoice, statedTotal === undefined ? {} : { statedTotal });
  const all = [...inputIssues, ...issues];
  current = invoice;

  for (const el of document.querySelectorAll<HTMLInputElement>("[aria-invalid]")) el.removeAttribute("aria-invalid");
  const fieldIds: Record<string, string> = { "seller.name": "seller-name", "seller.taxId": "seller-nif", "buyer.taxId": "buyer-nif", "buyer.name": "buyer-name", number: "number", issueDate: "date", total: "stated-total" };
  for (const i of all) if (i.field && fieldIds[i.field] && i.level === "error") input(fieldIds[i.field]!).setAttribute("aria-invalid", "true");

  const errors = all.filter((i) => i.level === "error").length;
  const status = $("status");
  status.className = `panel status ${errors ? "err" : all.length ? "warn" : "ok"}`;
  const [head, sub, badge] = errors ? [errors === 1 ? t("error1") : t("errors", { n: errors }), t("errorsSub"), "!"] : all.length ? [t("warnings"), t("warningsSub"), "•"] : [t("allGood"), t("allGoodSub"), "✓"];
  status.innerHTML = `<span class="badge" aria-hidden="true">${badge}</span><div><strong class="head"></strong><span class="sub"></span></div>`;
  status.querySelector(".head")!.textContent = head;
  status.querySelector(".sub")!.textContent = sub;

  const list = $("issues");
  list.replaceChildren(...(all.length ? all.map((i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pill ${i.level}"></span><span></span>`;
    li.children[0]!.textContent = t(i.level);
    li.children[1]!.textContent = i[lang];
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: t("nothing") })]));

  const money = (c: number) => formatMoney(c, "EUR", lang === "es" ? "es-ES" : "en-GB");
  const rows: [string, string, string?][] = [[t("type"), t(invoiceType(invoice)), "type"]];
  for (const g of totals.groups) rows.push([`${t("base")} ${formatRate(g.rate)}`, money(g.base)], [`${t("tax")} ${formatRate(g.rate)}`, money(g.tax)]);
  rows.push([t("total"), money(totals.total), "total"]);
  $("totals").replaceChildren(...rows.map(([a, b, cls]) => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    tr.innerHTML = "<td></td><td></td>";
    tr.children[0]!.textContent = a; tr.children[1]!.textContent = b;
    return tr;
  }));

  const url = qrUrl(invoice, "production", totals);
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const fp = invoice.seller.taxId ? await fingerprint(registrationFields(invoice, "", new Date(), totals)) : "—";
  if (id !== renderId) return;
  const qr = $("qr");
  qr.innerHTML = svg;
  qr.setAttribute("aria-label", t("qrAlt"));
  $("fp").textContent = fp;
}

function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.innerHTML = t(el.dataset.i18n!);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  document.title = lang === "es" ? "Comprobador de facturas Verifactu" : "Verifactu invoice checker";
  const rows = readLines();
  linesEl.replaceChildren(...rows.map(lineRow));
  update();
}

document.querySelectorAll<HTMLButtonElement>("[data-lang]").forEach((b) =>
  b.addEventListener("click", () => {
    lang = b.dataset.lang as Lang;
    try { localStorage.setItem("lang", lang); } catch { /* storage unavailable */ }
    applyLang();
  }),
);
$("form").addEventListener("input", () => { $("example-note").hidden = true; update(); });
$("add-line").addEventListener("click", () => {
  linesEl.append(lineRow({ description: "", quantity: "1", price: "", rate: "2100", exemption: "" }));
  (linesEl.lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
  update();
});
$("example").addEventListener("click", () => fill(EXAMPLE, true));
$("clear").addEventListener("click", () =>
  fill({ ...EXAMPLE, sellerName: "", sellerNif: "", number: "", date: today(), lines: [{ description: "", quantity: "1", price: "", rate: "2100", exemption: "" }] }, false),
);
$("pdf").addEventListener("click", async () => {
  if (!current) return;
  // The PDF library is large, so it only loads when someone asks for a PDF.
  const { renderInvoicePdf } = await import("../src/pdf.js");
  const bytes = await renderInvoicePdf(current, { lang, qr: qrUrl(current) });
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${current.number || "factura"}.pdf` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

fill(EXAMPLE, true);
if (lang !== "es") applyLang();
