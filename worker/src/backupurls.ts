/**
 * backupurls.ts — short-lived signed URLs for the R2 proxy endpoints.
 *
 * The device PUTs ciphertext to  {base}/backup/put?k=…&e=…&s=…  and GETs
 * restores from {base}/backup/get?k=…&e=…&s=…  — both HMAC-verified against
 * BACKUP_URL_SECRET, both expiring in minutes. The object KEY is always
 * server-generated (clients can never choose where another family's data
 * lives), so the signed URL grants access to exactly one object for the TTL.
 */

import { hmacHex } from "./crypto";
import type { Env } from "./env";

export interface SignedTarget {
  url: string;
  expiresIn: number;
}

function baseUrl(env: Env, request: Request): string {
  const configured = (request.headers.get("x-worker-base") ?? "").trim();
  const origin = configured || new URL(request.url).origin;
  return origin.replace(/\/$/, "");
}

/** Issues a signed PUT target for one object key. */
export async function signPut(
  env: Env,
  request: Request,
  key: string,
  ttlSeconds: number
): Promise<SignedTarget> {
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  const s = await hmacHex(env.BACKUP_URL_SECRET as string, `PUT|${key}|${e}`);
  const url = `${baseUrl(env, request)}/backup/put?k=${encodeURIComponent(key)}&e=${e}&s=${s}`;
  return { url, expiresIn: ttlSeconds };
}

/** Issues a signed GET target for one object key. */
export async function signGet(
  env: Env,
  request: Request,
  key: string,
  ttlSeconds: number
): Promise<SignedTarget> {
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  const s = await hmacHex(env.BACKUP_URL_SECRET as string, `GET|${key}|${e}`);
  const url = `${baseUrl(env, request)}/backup/get?k=${encodeURIComponent(key)}&e=${e}&s=${s}`;
  return { url, expiresIn: ttlSeconds };
}

/** Verifies method|key|expiry HMAC + freshness. Throws on any mismatch. */
export async function verifySignature(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  e: string,
  s: string
): Promise<void> {
  const expiry = Number(e);
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) {
    throw new Error("url_expired");
  }
  const expected = await hmacHex(env.BACKUP_URL_SECRET as string, `${method}|${key}|${expiry}`);
  if (expected.length !== s.length || expected !== s) {
    throw new Error("bad_signature");
  }
}
