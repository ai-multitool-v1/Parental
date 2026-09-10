/**
 * users.ts — parent profile helpers (port of functions lib/users.ts).
 *
 * users/{uid} is the parent profile (role=parent). FCM tokens for the web
 * dashboard live in its `fcmTokens` array; family escalation preference at
 * `settings.escalationMinutes`.
 */

import { FieldValue } from "firebase-admin/firestore";
import { db } from "./admin";
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
 * Family-configured SOS escalation threshold in minutes (1–120 clamp).
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
