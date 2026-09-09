/**
 * r2.ts — minimal Cloudflare R2 (S3-compatible) client for the backup flow.
 *
 * WHY hand-rolled SigV4 instead of the AWS SDK: the functions only need two
 * operations — short-TTL presigned PUT/GET URLs and one HEAD — and the SDK
 * adds ~50 MB of cold-start weight to every backup callable. This file is
 * a strict, auditable ~150-line implementation of exactly that surface.
 *
 * Config comes from the R2_* secrets (see constants.ts + README → R2 setup):
 *   R2_ACCOUNT_ID           Cloudflare account id (host suffix)
 *   R2_ACCESS_KEY_ID        R2 API token access key
 *   R2_SECRET_ACCESS_KEY    R2 API token secret
 *   R2_BUCKET_NAME          private bucket (never public-read)
 */

import { createHash, createHmac } from "node:crypto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Returns config from env, or null when not configured (feature degrades). */
export function r2ConfigFromEnv(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

const HOST = (cfg: R2Config) => `${cfg.accountId}.r2.cloudflarestorage.com`;
const REGION = "auto";
const SERVICE = "s3";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** URI-encode per AWS rules (path segments keep `/`). */
function awsUriEncode(str: string, encodeSlash = true): string {
  let out = "";
  for (const ch of str) {
    if (
      /[A-Za-z0-9_.~-]/.test(ch) ||
      (ch === "/" && !encodeSlash)
    ) {
      out += ch;
    } else {
      out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/**
 * Builds a presigned query URL (SigV4, UNSIGNED-PAYLOAD).
 * method = PUT (upload) | GET (download); ttlSeconds ≤ 7 days.
 */
export function presignR2(
  cfg: R2Config,
  key: string,
  method: "PUT" | "GET",
  ttlSeconds: number
): string {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const host = HOST(cfg);
  const path = `/${cfg.bucket}/${key.split("/").map((s) => awsUriEncode(s)).join("/")}`;

  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.min(Math.max(ttlSeconds, 1), 604800)),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** HEAD existence probe (backupCompleteUpload anti-fake verification). */
export async function r2HeadObject(
  cfg: R2Config,
  key: string
): Promise<{ exists: boolean; sizeBytes?: number }> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const host = HOST(cfg);
  const path = `/${cfg.bucket}/${key.split("/").map((s) => awsUriEncode(s)).join("/")}`;

  const canonicalRequest = [
    "HEAD",
    path,
    "",
    `host:${host}\nx-amz-content-sha256:${sha256Hex("")}\nx-amz-date:${amzDate}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    sha256Hex(""),
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

  try {
    const res = await fetch(`https://${host}${path}`, {
      method: "HEAD",
      headers: {
        host,
        "x-amz-content-sha256": sha256Hex(""),
        "x-amz-date": amzDate,
        authorization,
      },
    });
    if (res.status === 200) {
      const sizeHeader = res.headers.get("content-length");
      const sizeBytes = sizeHeader ? Number(sizeHeader) : undefined;
      return { exists: true, sizeBytes };
    }
    if (res.status === 404) return { exists: false };
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "r2_head_unexpected_status",
        status: res.status,
      })
    );
    return { exists: false };
  } catch (err) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "r2_head_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return { exists: false };
  }
}
