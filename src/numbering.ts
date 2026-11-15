/**
 * Invoice numbers must be consecutive with no gaps, and the same order must never
 * get two numbers, even if Shopify sends its webhook twice.
 */
export interface SequenceStore {
  /** Returns the number already given to `key`, or the next free one in `series`. */
  assign(series: string, key: string): Promise<number>;
}

export class MemorySequenceStore implements SequenceStore {
  private readonly last = new Map<string, number>();
  private readonly byKey = new Map<string, number>();

  async assign(series: string, key: string): Promise<number> {
    const id = `${series}\u0000${key}`;
    const existing = this.byKey.get(id);
    if (existing !== undefined) return existing;
    const next = (this.last.get(series) ?? 0) + 1;
    this.last.set(series, next);
    this.byKey.set(id, next);
    return next;
  }
}

/** "F2026-000042": a prefix per document type, a series per year. */
export function formatNumber(prefix: string, year: number, n: number): string {
  return `${prefix}${year}-${String(n).padStart(6, "0")}`;
}

export async function nextNumber(
  store: SequenceStore,
  prefix: string,
  issueDate: string,
  key: string,
): Promise<string> {
  const year = Number(issueDate.slice(0, 4));
  const series = `${prefix}${year}`;
  return formatNumber(prefix, year, await store.assign(series, key));
}
