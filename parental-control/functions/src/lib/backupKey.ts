/**
 * backupKey.ts — child backup DEK escrow (v1.3.0).
 *
 * THREAT MODEL: backups are end-to-end encrypted ON THE DEVICE (AES-256-GCM).
 * Firestore/R2 only ever see ciphertext. But the data-encryption key (DEK)
 * must survive phone resets so a re-paired device can restore — it is
 * escrowed in children/{childUid}/backupKeys/current, WRAPPED (AESGCM) under
 * a platform Key-Encryption-Key (KEK) held in the BACKUP_KEK secret.
 *
 *   plaintext DEK  ──wrap(KEK)──►  wrappedDekB64  ──► Firestore
 *   KEK                            (env/Secret Manager)   never in DB
 *
 * Plaintext key material exists ONLY inside callable memory (backupGetKey /
 * confirmPairing provisioning) and on the device. Never logged, never
 * returned in audits.
 *
 * BACKUP_KEK format: base64 of 32 bytes (an openssl rand -base64 32 output).
 * A raw passphrase is accepted and derived to 32 bytes via SHA-256 for
 * convenience, but 32 random bytes are recommended.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./verify";

const DOC_PATH = (childUid: string) => `children/${childUid}/backupKeys/current`;

/** True when the platform KEK is configured (else backup features degrade). */
export function isKekConfigured(): boolean {
  return typeof process.env.BACKUP_KEK === "string" && process.env.BACKUP_KEK.length > 0;
}

/** KEK bytes: base64-32 preferred; anything else derived via SHA-256. */
function kekBytes(): Buffer {
  const raw = process.env.BACKUP_KEK;
  if (!raw) throw new Error("BACKUP_KEK not configured");
  const trimmed = raw.trim();
  const asBuf = Buffer.from(trimmed, "base64");
  if (asBuf.length === 32) return asBuf;
  return createHash("sha256").update(trimmed).digest();
}

/** AES-256-GCM wrap → iv|tag|ciphertext, base64. */
function wrap(plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kekBytes(), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Inverse of wrap(). Throws when KEK mismatched (auth tag fails). */
function unwrap(wrappedB64: string): Buffer {
  const blob = Buffer.from(wrappedB64, "base64");
  if (blob.length < 12 + 16 + 1) throw new Error("wrapped DEK malformed");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", kekBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Provisions the child's DEK if absent (idempotent, called from
 * confirmPairing). Never overwrites an existing key — a lost overwrite
 * would orphan every existing backup.
 */
export async function ensureChildDek(childUid: string): Promise<void> {
  if (!isKekConfigured()) {
    throw new Error("BACKUP_KEK not configured");
  }
  const ref = db().doc(DOC_PATH(childUid));
  const snap = await ref.get();
  if (snap.exists && typeof snap.get("wrappedDekB64") === "string") return;

  const dek = randomBytes(32);
  await ref.set(
    {
      wrappedDekB64: wrap(dek),
      dekVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      rotatedAt: null,
    },
    { merge: false } // never silently clobber
  );
}

/**
 * Returns the child's DEK (base64) + version to an already-authorized
 * caller (backupGetKey verifies parent/device rights BEFORE this).
 */
export async function unwrapChildDek(
  childUid: string
): Promise<{ keyB64: string; keyVersion: number }> {
  if (!isKekConfigured()) {
    throw new Error("BACKUP_KEK not configured");
  }
  const snap = await db().doc(DOC_PATH(childUid)).get();
  if (!snap.exists) {
    // Legacy rows may not exist yet — provision on demand, then unwrap.
    await ensureChildDek(childUid);
    return unwrapChildDek(childUid);
  }
  const wrapped = snap.get("wrappedDekB64");
  const version = snap.get("dekVersion");
  if (typeof wrapped !== "string") {
    throw new Error("DEK escrow row malformed");
  }
  const dek = unwrap(wrapped);
  return {
    keyB64: dek.toString("base64"),
    keyVersion: typeof version === "number" ? version : 1,
  };
}
