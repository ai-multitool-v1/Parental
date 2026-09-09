/**
 * validate.ts — payload shaping + Firestore sliding-window rate limiter
 * (ports of functions lib/verify.ts payload + rate-limit sections).
 */

import { Timestamp } from "./admin";
import { db } from "./admin";
import { ApiError } from "./http";
import { PAIRING_CODE_ALPHABET } from "./constants";

/** Control chars are never allowed in client strings. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Canonical device UUID (what the Android app stores — random UUID v4). */
const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    throw new ApiError(
      "invalid-argument",
      'Field "deviceId" must be a canonical device UUID.'
    );
  }
  return value.toLowerCase();
}

export function requireString(
  value: unknown,
  name: string,
  maxLen: number
): string {
  if (typeof value !== "string") {
    throw new ApiError("invalid-argument", `Field "${name}" is required.`);
  }
  const v = value.trim();
  if (v.length === 0 || v.length > maxLen || CONTROL_RE.test(v)) {
    throw new ApiError(
      "invalid-argument",
      `Field "${name}" must be 1-${maxLen} printable characters.`
    );
  }
  return v;
}

export function requirePairingCode(value: unknown): string {
  const v = requireString(value, "code", 32);
  if (v.length !== 8 || [...v].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))) {
    throw new ApiError(
      "invalid-argument",
      'Field "code" must be the 8-character code shown on the parent dashboard.'
    );
  }
  return v;
}

export function optionalString(
  value: unknown,
  name: string,
  maxLen: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("invalid-argument", `Field "${name}" must be a string.`);
  }
  const v = value.trim();
  if (v.length === 0) return undefined;
  if (v.length > maxLen || CONTROL_RE.test(v)) {
    throw new ApiError(
      "invalid-argument",
      `Field "${name}" must be at most ${maxLen} printable characters.`
    );
  }
  return v;
}

export interface RateLimitOpts {
  max: number;
  windowMs: number;
}

/**
 * Firestore sliding-window rate limiter (defense in depth). One doc per key:
 * rateLimits/{sha256(key)} holds timestamps of hits inside the window.
 */
export async function enforceRateLimit(
  key: string,
  opts: RateLimitOpts,
  userMessage: string
): Promise<void> {
  const docId = await sha256Prefix(key);
  const ref = db().doc(`rateLimits/${docId}`);
  const now = Date.now();
  const windowStart = Timestamp.fromMillis(now - opts.windowMs);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? {};
    const hits = Array.isArray(data["hits"])
      ? (data["hits"] as Timestamp[]).filter(
          (t) =>
            t &&
            typeof t.toMillis === "function" &&
            t.toMillis() > windowStart.toMillis()
        )
      : [];

    if (hits.length >= opts.max) {
      throw new ApiError("resource-exhausted", userMessage);
    }

    hits.push(Timestamp.fromMillis(now));
    tx.set(
      ref,
      {
        keyPrefix: key.slice(0, 64),
        hits,
        updatedAt: Timestamp.fromMillis(now),
      },
      { merge: true }
    );
  });
}

async function sha256Prefix(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}
