/**
 * Amounts are whole cents and tax rates are basis points (21% = 2100), so no
 * floating point ever touches money.
 */

export type Cents = number;
export type BasisPoints = number;

/** Divides and rounds half away from zero, the way invoice amounts are rounded. */
export function roundDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("denominator must be positive");
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const q = Math.floor(n / denominator);
  const r = n - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

/** Parses "12.5", "12,50" or 12.5 into cents. More than two decimals are rounded. */
export function toCents(value: string | number): Cents {
  const text = typeof value === "number" ? value.toFixed(6) : value.trim().replace(",", ".");
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`not an amount: ${JSON.stringify(value)}`);
  const [, minus, whole = "0", fraction = ""] = match;
  const digits = fraction.padEnd(2, "0");
  let cents = Number(whole) * 100 + Number(digits.slice(0, 2));
  const rest = digits.slice(2);
  if (rest && Number(rest[0]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw new RangeError("amount too large");
  return minus ? -cents : cents;
}

/** Converts a rate such as 0.21 or "21" (percent) into basis points. */
export function toBasisPoints(rate: number, unit: "fraction" | "percent" = "fraction"): BasisPoints {
  return Math.round(rate * (unit === "fraction" ? 10000 : 100));
}

/** "1234.50": the plain format tax authorities expect. */
export function formatPlain(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: Cents, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function formatRate(rate: BasisPoints): string {
  return `${(rate / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
