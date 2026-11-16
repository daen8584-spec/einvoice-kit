import { fingerprint, type ChainedRecord } from "./verifactu.js";

export type ChainCheck = { ok: true } | { ok: false; index: number; reason: "fingerprint" | "link" };

/**
 * Recomputes every fingerprint and checks each record points at the one before.
 * This is what a tax inspector's tools do: any edited, removed or reordered
 * record shows up at the exact place it happened.
 */
export async function verifyChain(records: readonly ChainedRecord[]): Promise<ChainCheck> {
  let previous = "";
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.fields.Huella !== previous) return { ok: false, index: i, reason: "link" };
    if ((await fingerprint(r.fields)) !== r.fingerprint) return { ok: false, index: i, reason: "fingerprint" };
    previous = r.fingerprint;
  }
  return { ok: true };
}
