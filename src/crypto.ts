import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** AES-256-GCM: confidentiality plus a check that nothing was altered. */
export class Cipher {
  private readonly key: Buffer;

  constructor(key: Buffer | string) {
    this.key = typeof key === "string" ? Buffer.from(key, "base64") : key;
    if (this.key.length !== 32) throw new Error("encryption keys must be 32 bytes (base64 when given as text)");
  }

  /** A separate key for one purpose, so documents and access tokens never share a key. */
  derive(purpose: string): Cipher {
    return new Cipher(Buffer.from(hkdfSync("sha256", this.key, Buffer.alloc(0), `einvoice-kit:${purpose}`, 32)));
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
  }

  open(sealed: string): string {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  }
}

const PREFIX = "enc1:";

/** JSON, encrypted when a cipher is given. Encrypted values carry a prefix so older plain rows still read. */
export function pack(value: unknown, cipher?: Cipher): string {
  const json = JSON.stringify(value);
  return cipher ? PREFIX + cipher.seal(json) : json;
}

export function unpack<T>(text: string, cipher?: Cipher): T {
  if (!text.startsWith(PREFIX)) return JSON.parse(text) as T;
  if (!cipher) throw new Error("this data is encrypted and no key was given");
  return JSON.parse(cipher.open(text.slice(PREFIX.length))) as T;
}

export const isEncrypted = (text: string) => text.startsWith(PREFIX);
