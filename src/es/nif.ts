/**
 * Spanish tax IDs: DNI (citizens), NIE (foreign residents), CIF-style NIFs
 * (companies and other entities) and the K/L/M forms. Each ends in a check
 * character, so a typo is caught before the invoice reaches the tax office.
 */

export type TaxIdKind = "DNI" | "NIE" | "KLM" | "ENTITY";

export type TaxIdResult =
  | { valid: true; kind: TaxIdKind; normalized: string }
  | { valid: false; reason: "format" | "check" };

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const ENTITY_LETTERS = "JABCDEFGHI";
/** Entities whose check character is always a letter, or always a digit. */
const ENTITY_LETTER_ONLY = "NPQRSW";
const ENTITY_DIGIT_ONLY = "ABEH";

export function normalizeTaxId(value: string): string {
  return value.toUpperCase().replace(/[\s.-]/g, "").replace(/^ES/, "");
}

function entityCheck(digits: string): { digit: string; letter: string } {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = Number(digits[i]);
    if (i % 2 === 1) sum += n;
    else {
      const doubled = n * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    }
  }
  const c = (10 - (sum % 10)) % 10;
  return { digit: String(c), letter: ENTITY_LETTERS[c]! };
}

export function validateTaxId(value: string): TaxIdResult {
  const id = normalizeTaxId(value);

  if (/^\d{8}[A-Z]$/.test(id)) {
    const ok = DNI_LETTERS[Number(id.slice(0, 8)) % 23] === id[8];
    return ok ? { valid: true, kind: "DNI", normalized: id } : { valid: false, reason: "check" };
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    const n = Number("XYZ".indexOf(id[0]!) + id.slice(1, 8));
    const ok = DNI_LETTERS[n % 23] === id[8];
    return ok ? { valid: true, kind: "NIE", normalized: id } : { valid: false, reason: "check" };
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(id)) {
    const ok = DNI_LETTERS[Number(id.slice(1, 8)) % 23] === id[8];
    return ok ? { valid: true, kind: "KLM", normalized: id } : { valid: false, reason: "check" };
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(id)) {
    const { digit, letter } = entityCheck(id.slice(1, 8));
    const first = id[0]!;
    const given = id[8]!;
    let ok: boolean;
    if (ENTITY_LETTER_ONLY.includes(first)) ok = given === letter;
    else if (ENTITY_DIGIT_ONLY.includes(first)) ok = given === digit;
    else ok = given === digit || given === letter;
    return ok ? { valid: true, kind: "ENTITY", normalized: id } : { valid: false, reason: "check" };
  }
  return { valid: false, reason: "format" };
}
