/**
 * crypto.ts — WebCrypto helpers (the Workers runtime has no Node cipher API).
 *
 * All crypto for the platform KEK (backup DEK escrow) and the HMAC-signed
 * R2 proxy URLs is implemented on the native WebCrypto subtle API — constant-
 * time verification via crypto.subtle.verify, AES-256-GCM AEAD for wrap/unwrap.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64decode(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/** HMAC-SHA256(secret, message) → hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacB64(
  secret: string,
  message: string
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return b64encode(sig);
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** randomBytes → base64 (KEK format parity with `openssl rand -base64 32`). */
export function randomB64(n: number): string {
  return b64encode(randomBytes(n));
}

/* ─────────────────────── AES-256-GCM DEK wrap/unwrap ────────────────────── */
/* Blob layout (identical to the functions implementation): iv(12)|tag(16)|ct */

async function kekBytes(raw: string): Promise<Uint8Array> {
  const trimmed = raw.trim();
  const asBuf = b64decode(trimmed);
  if (asBuf.length === 32) return asBuf;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(trimmed)));
}

async function kekKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", (await kekBytes(raw)) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-256-GCM wrap → iv|tag|ciphertext, base64. */
export async function wrapAesGcm(plaintext: Uint8Array, kek: string): Promise<string> {
  const iv = randomBytes(12);
  const key = await kekKey(kek);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  // WebCrypto appends the 16-byte tag to the ciphertext — layout matches.
  const blob = new Uint8Array(iv.length + ct.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ct), iv.length);
  return b64encode(blob);
}

/** Inverse of wrapAesGcm(). Throws when KEK mismatched (auth tag fails). */
export async function unwrapAesGcm(blobB64: string, kek: string): Promise<Uint8Array> {
  const blob = b64decode(blobB64);
  if (blob.length < 12 + 16 + 1) throw new Error("wrapped DEK malformed");
  const iv = blob.subarray(0, 12);
  const key = await kekKey(kek);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    blob.subarray(12) as BufferSource
  );
  return new Uint8Array(pt);
}

export { decoder };
