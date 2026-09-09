/**
 * backupkey.ts — child backup DEK escrow (WebCrypto port of functions'
 * lib/backupKey.ts — same Firestore blob layout: iv|tag|ct, base64).
 *
 * THREAT MODEL: backups are end-to-end encrypted ON THE DEVICE (AES-256-GCM).
 * Firestore/R2 only ever see ciphertext. The data-encryption key (DEK) must
 * survive phone resets, so it is escrowed in children/{uid}/backupKeys/current,
 * WRAPPED under a platform Key-Encryption-Key held in the BACKUP_KEK secret.
 *
 * Plaintext key material exists ONLY inside Worker memory and on the device.
 * Never logged, never returned in audits.
 */

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
import { wrapAesGcm, unwrapAesGcm, randomB64 } from "./crypto";
import type { Env } from "./env";

const DOC_PATH = (childUid: string) => `children/${childUid}/backupKeys/current`;

/** True when the platform KEK is configured (else backup features degrade). */
export function isKekConfigured(env: Env): boolean {
  return typeof env.BACKUP_KEK === "string" && env.BACKUP_KEK.length > 0;
}

/**
 * Provisions the child's DEK if absent (idempotent, called from
 * confirmPairing). Never overwrites an existing key — a lost overwrite
 * would orphan every existing backup.
 */
export async function ensureChildDek(env: Env, childUid: string): Promise<void> {
  if (!isKekConfigured(env)) {
    throw new Error("BACKUP_KEK not configured");
  }
  const ref = db().doc(DOC_PATH(childUid));
  const snap = await ref.get();
  if (snap.exists && typeof snap.get("wrappedDekB64") === "string") return;

  const dek = randomB64(32);
  const wrapped = await wrapAesGcm(
    Uint8Array.from(atob(dek), (c) => c.charCodeAt(0)),
    env.BACKUP_KEK as string
  );
  await ref.set(
    {
      wrappedDekB64: wrapped,
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
  env: Env,
  childUid: string
): Promise<{ keyB64: string; keyVersion: number }> {
  if (!isKekConfigured(env)) {
    throw new Error("BACKUP_KEK not configured");
  }
  const snap = await db().doc(DOC_PATH(childUid)).get();
  if (!snap.exists) {
    // Legacy rows may not exist yet — provision on demand, then unwrap.
    await ensureChildDek(env, childUid);
    return unwrapChildDek(env, childUid);
  }
  const wrapped = snap.get("wrappedDekB64");
  const version = snap.get("dekVersion");
  if (typeof wrapped !== "string") {
    throw new Error("DEK escrow row malformed");
  }
  const dek = await unwrapAesGcm(wrapped, env.BACKUP_KEK as string);
  let bin = "";
  for (let i = 0; i < dek.length; i += 0x8000) {
    bin += String.fromCharCode(...dek.subarray(i, i + 0x8000));
  }
  return {
    keyB64: btoa(bin),
    keyVersion: typeof version === "number" ? version : 1,
  };
}
