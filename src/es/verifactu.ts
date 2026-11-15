import { computeTotals, type Invoice, type Totals } from "../invoice.js";
import { formatPlain } from "../money.js";

/**
 * Verifactu record fields and the "huella" (fingerprint) that chains each record
 * to the one before it, following the AEAT technical specification for the hash.
 * Changing or deleting any earlier invoice breaks every fingerprint after it.
 */

export type InvoiceType = "F1" | "F2" | "R1" | "R5";

export const SIMPLIFIED_LIMIT_CENTS = 400_00;
/** Retail and some other sectors may issue simplified invoices up to this amount. */
export const SIMPLIFIED_SECTOR_LIMIT_CENTS = 3000_00;

export const QR_BASE = {
  test: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR",
  production: "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR",
} as const;

/** A full invoice names the buyer's tax ID; a simplified one ("ticket") doesn't. */
export function invoiceType(invoice: Invoice): InvoiceType {
  const full = Boolean(invoice.buyer?.taxId);
  if (invoice.kind === "credit-note") return full ? "R1" : "R5";
  return full ? "F1" : "F2";
}

/** "2024-01-31" becomes "31-01-2024". */
export function aeatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}-${m}-${y}`;
}

/** "2024-01-01T19:20:30+01:00": local time in Spain with its UTC offset. */
export function timestampWithOffset(date: Date, timeZone = "Europe/Madrid"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

export interface RegistrationFields {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  FechaExpedicionFactura: string;
  TipoFactura: InvoiceType;
  CuotaTotal: string;
  ImporteTotal: string;
  Huella: string;
  FechaHoraHusoGenRegistro: string;
}

export interface CancellationFields {
  IDEmisorFacturaAnulada: string;
  NumSerieFacturaAnulada: string;
  FechaExpedicionFacturaAnulada: string;
  Huella: string;
  FechaHoraHusoGenRegistro: string;
}

const REGISTRATION_ORDER = [
  "IDEmisorFactura", "NumSerieFactura", "FechaExpedicionFactura", "TipoFactura",
  "CuotaTotal", "ImporteTotal", "Huella", "FechaHoraHusoGenRegistro",
] as const;
const CANCELLATION_ORDER = [
  "IDEmisorFacturaAnulada", "NumSerieFacturaAnulada", "FechaExpedicionFacturaAnulada",
  "Huella", "FechaHoraHusoGenRegistro",
] as const;

/**
 * The exact text that gets hashed. The field order is fixed by the specification,
 * so it's spelled out here rather than taken from however the object was built.
 */
export function fingerprintInput(fields: RegistrationFields | CancellationFields): string {
  const order: readonly string[] = "IDEmisorFacturaAnulada" in fields ? CANCELLATION_ORDER : REGISTRATION_ORDER;
  const values = fields as unknown as Record<string, string>;
  return order.map((k) => `${k}=${String(values[k] ?? "").trim()}`).join("&");
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function fingerprint(fields: RegistrationFields | CancellationFields): Promise<string> {
  return sha256Hex(fingerprintInput(fields));
}

export function registrationFields(
  invoice: Invoice,
  previousFingerprint: string,
  generatedAt: Date,
  totals: Totals = computeTotals(invoice),
): RegistrationFields {
  return {
    IDEmisorFactura: invoice.seller.taxId ?? "",
    NumSerieFactura: invoice.number,
    FechaExpedicionFactura: aeatDate(invoice.issueDate),
    TipoFactura: invoiceType(invoice),
    CuotaTotal: formatPlain(totals.tax),
    ImporteTotal: formatPlain(totals.total),
    Huella: previousFingerprint,
    FechaHoraHusoGenRegistro: timestampWithOffset(generatedAt),
  };
}

export interface ChainedRecord {
  fields: RegistrationFields | CancellationFields;
  fingerprint: string;
}

/**
 * Keeps the chain for one seller. Records must be added in the order they are
 * generated; the store that persists `last` has to do that atomically.
 */
export class RecordChain {
  constructor(public last = "") {}

  async register(invoice: Invoice, generatedAt = new Date()): Promise<ChainedRecord> {
    const fields = registrationFields(invoice, this.last, generatedAt);
    const fp = await fingerprint(fields);
    this.last = fp;
    return { fields, fingerprint: fp };
  }

  async cancel(
    invoice: Pick<Invoice, "seller" | "number" | "issueDate">,
    generatedAt = new Date(),
  ): Promise<ChainedRecord> {
    const fields: CancellationFields = {
      IDEmisorFacturaAnulada: invoice.seller.taxId ?? "",
      NumSerieFacturaAnulada: invoice.number,
      FechaExpedicionFacturaAnulada: aeatDate(invoice.issueDate),
      Huella: this.last,
      FechaHoraHusoGenRegistro: timestampWithOffset(generatedAt),
    };
    const fp = await fingerprint(fields);
    this.last = fp;
    return { fields, fingerprint: fp };
  }
}

/** The link printed as a QR code, which lets anyone check the invoice with the AEAT. */
export function qrUrl(
  invoice: Invoice,
  env: keyof typeof QR_BASE = "production",
  totals: Totals = computeTotals(invoice),
): string {
  const params = new URLSearchParams({
    nif: invoice.seller.taxId ?? "",
    numserie: invoice.number,
    fecha: aeatDate(invoice.issueDate),
    importe: formatPlain(totals.total),
  });
  return `${QR_BASE[env]}?${params.toString()}`;
}
