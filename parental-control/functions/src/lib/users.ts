/**
 * users.ts — parent profile helpers shared by emergency/escalation flows.
 *
 * users/{uid} is the parent profile (role=parent). FCM tokens for the web
 * dashboard are stored in its `fcmTokens` array (registration tokens rotate
 * often — invalid ones are pruned by the senders). Per-family escalation
 * preference lives at `settings.escalationMinutes` inside the same doc.
 */

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./verify";
import { DEFAULT_ESCALATION_MINUTES } from "./constants";

/** Valid-looking FCM registration token (length sanity only). */
function isValidToken(t: unknown): t is string {
  return typeof t === "string" && t.length >= 32 && t.length <= 4096;
}

/** Returns the parent's registered dashboard tokens (deduplicated). */
export async function getFcmTokensForUser(uid: string): Promise<string[]> {
  const snap = await db().doc(`users/${uid}`).get();
  const raw = snap.get("fcmTokens");
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isValidToken))];
}

/** Removes pruned/invalid tokens so dead registration ids do not pile up. */
export async function pruneFcmTokensForUser(
  uid: string,
  invalidTokens: string[]
): Promise<void> {
  if (invalidTokens.length === 0) return;
  try {
    await db()
      .doc(`users/${uid}`)
      .update({ fcmTokens: FieldValue.arrayRemove(...invalidTokens) });
  } catch (err) {
    // Best-effort hygiene only.
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "fcm_token_prune_failed",
        uid,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/**
 * Family-configured SOS escalation threshold in minutes.
 * Read from users/{uid}.settings.escalationMinutes with a sane clamp
 * (1–120 min); falls back to the platform default when unset.
 */
export async function getEscalationMinutes(uid: string): Promise<number> {
  try {
    const snap = await db().doc(`users/${uid}`).get();
    const settings = snap.get("settings") as Record<string, unknown> | undefined;
    const raw = settings?.["escalationMinutes"];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.min(120, Math.max(1, Math.round(raw)));
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_ESCALATION_MINUTES;
}
