/**
 * onParentLogin.ts — Auth blocking function (beforeUserSignedIn).
 *
 * OPTIONAL hardening layer: must be enabled per-provider in
 * Firebase Console → Authentication → Settings → Blocking functions
 * (adds ~50–200 ms to each sign-in; do NOT enable for the anonymous
 * provider used by child devices).
 *
 * Behaviour:
 *   1. Skips anonymous provider sign-ins (child device identities).
 *   2. Refuses sign-in when users/{uid}.accountLocked === true
 *      (set only via console / Admin SDK — clients can never flip it).
 *   3. v1.2.0: Refuses sign-in when users/{uid}.banned === true (Developer
 *      Admin ban system — set exclusively by adminSetBanState callable).
 *   4. Sliding-window rate limit: max LOGIN_RATE_MAX parent sign-ins per
 *      LOGIN_WINDOW_MS (counts our own PARENT_LOGIN audit entries).
 *   5. Audits PARENT_LOGIN / LOGIN_BLOCKED to the platform-wide audit log.
 */

import { beforeUserSignedIn } from "firebase-functions/v2/identity";
import { HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { LOGIN_RATE_MAX, LOGIN_WINDOW_MS, REGION } from "../lib/constants";

export const onParentLogin = beforeUserSignedIn(
  { region: REGION },
  async (event) => {
    const user = event.data;
    if (!user) return {};

    const providers = (user.providerData ?? []).map((p) => p.providerId);
    // Child device identities are anonymous — skip parent login logic.
    if (providers.includes("anonymous")) return {};

    const uid = user.uid;

    /* ---------- 1. account lock check ------------------------------- */
    const profile = await db().doc(`users/${uid}`).get();
    if (profile.exists && profile.get("accountLocked") === true) {
      await writeAudit({
        functionName: "onParentLogin",
        actorUid: uid,
        actorType: "PARENT",
        action: "LOGIN_BLOCKED",
        result: "DENIED",
        details: { reason: "account_locked" },
      });
      throw new HttpsError(
        "permission-denied",
        "This account is locked. Contact your family administrator."
      );
    }

    /* ---------- 1b. developer-admin ban check (v1.2.0) --------------- */
    if (profile.exists && profile.get("banned") === true) {
      await writeAudit({
        functionName: "onParentLogin",
        actorUid: uid,
        actorType: "PARENT",
        action: "LOGIN_BLOCKED",
        result: "DENIED",
        details: {
          reason: "banned_by_admin",
          bannedReason: profile.get("bannedReason") ?? null,
        },
      });
      throw new HttpsError(
        "permission-denied",
        "This account has been suspended. Contact support to appeal."
      );
    }

    /* ---------- 2. sliding-window sign-in rate limit ----------------- */
    const recent = await db()
      .collection("auditLogs")
      .where("actorUid", "==", uid)
      .where("action", "==", "PARENT_LOGIN")
      .where("createdAt", ">", Timestamp.fromMillis(Date.now() - LOGIN_WINDOW_MS))
      .count()
      .get();

    if ((recent.data().count ?? 0) >= LOGIN_RATE_MAX) {
      await writeAudit({
        functionName: "onParentLogin",
        actorUid: uid,
        actorType: "PARENT",
        action: "LOGIN_BLOCKED",
        result: "DENIED",
        details: { reason: "rate_limited", windowMs: LOGIN_WINDOW_MS },
      });
      throw new HttpsError(
        "resource-exhausted",
        "Too many sign-in attempts. Please wait 15 minutes and try again."
      );
    }

    /* ---------- 3. audit the successful sign-in ---------------------- */
    await writeAudit({
      functionName: "onParentLogin",
      actorUid: uid,
      actorType: "PARENT",
      action: "PARENT_LOGIN",
      result: "ALLOWED",
      details: { providers },
    });

    return {};
  }
);
