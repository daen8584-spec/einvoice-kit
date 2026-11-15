import { computeTotals, lineAmount, type Invoice, type Totals } from "../invoice.js";
import { formatPlain } from "../money.js";
import { validateTaxId } from "./nif.js";
import { SIMPLIFIED_LIMIT_CENTS, SIMPLIFIED_SECTOR_LIMIT_CENTS, invoiceType } from "./verifactu.js";

/** Plain-language checks of what a Spanish invoice needs, in Spanish and English. */

export interface Issue {
  level: "error" | "warning";
  code: string;
  field?: string;
  es: string;
  en: string;
}

export const STANDARD_RATES = [2100, 1000, 400, 0];

export interface CheckOptions {
  /** The total printed on the invoice, to compare with the computed one. */
  statedTotal?: number;
  today?: string;
}

/** Spanish writes amounts with a decimal comma. */
const es = (cents: number) => formatPlain(cents).replace(".", ",");

const issue = (level: Issue["level"], code: string, es: string, en: string, field?: string): Issue =>
  field ? { level, code, es, en, field } : { level, code, es, en };

export function checkSpanishInvoice(invoice: Invoice, options: CheckOptions = {}): { issues: Issue[]; totals: Totals } {
  const issues: Issue[] = [];
  const totals = computeTotals(invoice);
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  if (!invoice.seller.name.trim())
    issues.push(issue("error", "seller-name", "Falta el nombre o razón social del vendedor.", "The seller's name is missing.", "seller.name"));

  const sellerId = invoice.seller.taxId?.trim() ?? "";
  if (!sellerId) {
    issues.push(issue("error", "seller-nif", "Falta el NIF del vendedor. Es obligatorio en toda factura.", "The seller's tax ID (NIF) is missing. Every invoice needs it.", "seller.taxId"));
  } else {
    const r = validateTaxId(sellerId);
    if (!r.valid)
      issues.push(r.reason === "check"
        ? issue("error", "seller-nif", "El NIF del vendedor no es válido: la letra o dígito de control no coincide. Revisa si hay una errata.", "The seller's NIF isn't valid: the check character doesn't match. Look for a typo.", "seller.taxId")
        : issue("error", "seller-nif", "El NIF del vendedor no tiene un formato español válido.", "The seller's NIF isn't in a valid Spanish format.", "seller.taxId"));
  }

  const number = invoice.number.trim();
  if (!number)
    issues.push(issue("error", "number", "Falta el número de factura.", "The invoice number is missing.", "number"));
  else if (number.length > 60)
    issues.push(issue("error", "number", "El número de factura no puede tener más de 60 caracteres en Verifactu.", "Verifactu allows invoice numbers of up to 60 characters.", "number"));
  else if (!/^[\x20-\x7E]+$/.test(number))
    issues.push(issue("warning", "number", "El número de factura tiene caracteres especiales. Usa solo letras, números y símbolos simples como / o -.", "The invoice number has special characters. Stick to letters, digits and simple symbols like / or -.", "number"));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.issueDate) || Number.isNaN(Date.parse(invoice.issueDate)))
    issues.push(issue("error", "date", "Falta la fecha de la factura o no es válida.", "The invoice date is missing or invalid.", "issueDate"));
  else if (invoice.issueDate > today)
    issues.push(issue("error", "date", "La fecha de la factura está en el futuro.", "The invoice date is in the future.", "issueDate"));

  const buyerId = invoice.buyer?.taxId?.trim();
  if (buyerId) {
    const r = validateTaxId(buyerId);
    if (!r.valid)
      issues.push(issue("error", "buyer-nif", "El NIF del cliente no es válido. Revisa si hay una errata.", "The customer's NIF isn't valid. Look for a typo.", "buyer.taxId"));
    if (!invoice.buyer?.name.trim())
      issues.push(issue("error", "buyer-name", "Si pones el NIF del cliente, también hace falta su nombre (factura completa).", "If you include the customer's NIF, you also need their name (full invoice).", "buyer.name"));
  }

  if (invoiceType(invoice) === "F2") {
    if (totals.total > SIMPLIFIED_SECTOR_LIMIT_CENTS)
      issues.push(issue("error", "simplified-limit", "Sin NIF del cliente es una factura simplificada, y no puede superar 3.000 € en ningún caso. Añade los datos del cliente.", "Without the customer's NIF this is a simplified invoice, which can never exceed €3,000. Add the customer's details.", "buyer.taxId"));
    else if (totals.total > SIMPLIFIED_LIMIT_CENTS)
      issues.push(issue("warning", "simplified-limit", "Sin NIF del cliente es una factura simplificada. Por encima de 400 € solo se permite en ciertos sectores, como el comercio minorista (hasta 3.000 €).", "Without the customer's NIF this is a simplified invoice. Above €400 that's only allowed in some sectors, such as retail (up to €3,000).", "buyer.taxId"));
  }

  if (invoice.lines.length === 0)
    issues.push(issue("error", "lines", "La factura no tiene ninguna línea.", "The invoice has no lines.", "lines"));

  invoice.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.description.trim())
      issues.push(issue("error", "line-description", `La línea ${n} no tiene descripción.`, `Line ${n} has no description.`, `lines.${i}.description`));
    if (!STANDARD_RATES.includes(line.rate))
      issues.push(issue("warning", "line-rate", `La línea ${n} usa un IVA del ${line.rate / 100} %. Los tipos habituales son 21 %, 10 %, 4 % y 0 %.`, `Line ${n} uses ${line.rate / 100}% VAT. The usual rates are 21%, 10%, 4% and 0%.`, `lines.${i}.rate`));
    if (line.rate === 0 && !line.exemption?.trim())
      issues.push(issue("error", "line-exemption", `La línea ${n} no lleva IVA. La factura tiene que indicar por qué (por ejemplo, el artículo de la ley que la exime).`, `Line ${n} has no VAT. The invoice has to say why (for example, the article of the law that exempts it).`, `lines.${i}.exemption`));
    const amount = lineAmount(line);
    if (invoice.kind === "invoice" && amount < 0)
      issues.push(issue("error", "line-negative", `La línea ${n} es negativa. Las devoluciones van en una factura rectificativa, no en una normal.`, `Line ${n} is negative. Refunds go on a corrective invoice, not a normal one.`, `lines.${i}`));
  });

  if (invoice.kind === "credit-note") {
    if (!invoice.corrects?.number || !invoice.corrects.issueDate)
      issues.push(issue("error", "corrects", "Una factura rectificativa tiene que indicar el número y la fecha de la factura que corrige.", "A corrective invoice has to give the number and date of the invoice it corrects.", "corrects"));
    if (!invoice.corrects?.reason?.trim())
      issues.push(issue("warning", "corrects-reason", "Indica el motivo de la rectificación, por ejemplo «devolución de mercancía».", "Give the reason for the correction, for example \"goods returned\".", "corrects.reason"));
  }

  if (options.statedTotal !== undefined && options.statedTotal !== totals.total)
    issues.push(issue("error", "total-mismatch", `El total de tu factura (${es(options.statedTotal)}) no coincide con la suma de las líneas más el IVA (${es(totals.total)}).`, `Your invoice's total (${formatPlain(options.statedTotal)}) doesn't match the lines plus VAT (${formatPlain(totals.total)}).`, "total"));

  return { issues, totals };
}
