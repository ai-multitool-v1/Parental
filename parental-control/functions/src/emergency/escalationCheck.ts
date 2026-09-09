/**
 * escalationCheck.ts — scheduled every 1 minute.
 *
 * Finds top-level emergencyAlerts that are still unacknowledged and, once the
 * family-configured threshold has passed, sends reminder pushes to:
 *   - every paired parent's tokens, and
 *   - any secondary emergency contacts the parent added voluntarily
 *     (users/{parentUid}/emergencyContacts — entered BY the parent; the
 *     system never auto-contacts third parties beyond these stored contacts,
 *     never sends SMS, and never contacts emergency services).
 *
 * Threshold: users/{parentUid}/settings.escalationMinutes (default 5 min).
 * When several parents are paired we use the SMALLEST threshold (fail loud).
 *
 * ⚠ THIS IS A FAMILY ALERT LOOP. It must NEVER present itself as a
 * replacement for emergency services. Reminder copy always includes the
 * local emergency number guidance.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";
import {
  getEscalationMinutes,
  getFcmTokensForUser,
  pruneFcmTokensForUser,
} from "../lib/users";
import { DEFAULT_ESCALATION_MINUTES, REMINDER_INTERVAL_MS, REGION } from "../lib/constants";

const MAX_ALERTS_PER_RUN = 200;

export const escalationCheck = onSchedule(
  {
    schedule: "every 1 minutes",
    region: REGION,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const now = Date.now();

    const openAlerts = await db()
      .collection("emergencyAlerts")
      .where("acknowledged", "==", false)
      .limit(MAX_ALERTS_PER_RUN)
      .get();

    for (const alertDoc of openAlerts.docs) {
      const alert = alertDoc.data();
      const parentUids = Array.isArray(alert["parentUids"])
        ? (alert["parentUids"] as string[])
        : [];
      if (parentUids.length === 0) continue;

      const createdAt = alert["createdAt"] as Timestamp | undefined;
      const createdAtMs =
        createdAt && typeof createdAt.toMillis === "function"
          ? createdAt.toMillis()
          : 0;
      if (createdAtMs === 0) continue;

      const lastReminded = alert["lastRemindedAt"] as Timestamp | undefined;
      const lastRemindedMs =
        lastReminded && typeof lastReminded.toMillis === "function"
          ? lastReminded.toMillis()
          : 0;
      if (now - lastRemindedMs < REMINDER_INTERVAL_MS) continue;

      // Smallest configured threshold wins (fail loud, remind early).
      const thresholds = await Promise.all(parentUids.map(getEscalationMinutes));
      const escalationMinutes = thresholds.length
        ? Math.min(...thresholds)
        : DEFAULT_ESCALATION_MINUTES;

      if (now < createdAtMs + escalationMinutes * 60_000) continue;

      /* ---------------- remind all paired parents ---------------- */
      const notifiedParents: string[] = [];
      for (const parentUid of parentUids) {
        const tokens = await getFcmTokensForUser(parentUid);
        const invalid: string[] = [];
        for (const token of tokens) {
          try {
            await getMessaging().send({
              token,
              notification: {
                title: "Unacknowledged SOS — action needed",
                body:
                  `The SOS from ${String(alert["deviceName"] ?? "a device")} has not been ` +
                  `acknowledged for ${escalationMinutes} minute(s). If this is a real ` +
                  `emergency, call your local emergency number now.`,
              },
              data: {
                kind: "SOS_ESCALATION",
                eventId: String(alert["eventId"] ?? alertDoc.id),
                deviceId: String(alert["deviceId"] ?? ""),
              },
              android: { priority: "high" },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("registration-token-not-registered")) {
              invalid.push(token);
            }
          }
        }
        await pruneFcmTokensForUser(parentUid, invalid);
        notifiedParents.push(parentUid);

        /* -------- notify secondary emergency contacts (optional) --- */
        const contacts = await db()
          .collection(`users/${parentUid}/emergencyContacts`)
          .get();
        for (const contactDoc of contacts.docs) {
          const contactToken = contactDoc.get("fcmToken");
          if (typeof contactToken === "string" && contactToken.length > 0) {
            try {
              await getMessaging().send({
                token: contactToken,
                data: {
                  kind: "SOS_CONTACT_NOTICE",
                  eventId: String(alert["eventId"] ?? alertDoc.id),
                  deviceId: String(alert["deviceId"] ?? ""),
                  parentUid,
                },
                android: { priority: "high" },
              });
            } catch {
              // Contact delivery is best-effort by design.
            }
          }
        }
      }

      await alertDoc.ref.update({
        reminderCount: FieldValue.increment(1),
        lastRemindedAt: FieldValue.serverTimestamp(),
      });

      await writeAudit({
        functionName: "escalationCheck",
        actorUid: "system",
        actorType: "SYSTEM",
        action: "ESCALATION_REMINDER",
        result: "INFO",
        details: {
          eventId: alertDoc.id,
          escalationMinutes,
          notifiedParents,
        },
      });
    }
  }
);
