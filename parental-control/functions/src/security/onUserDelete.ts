/**
 * onUserDelete.ts — Auth user delete trigger (GDPR "right to erasure").
 *
 * Supports account deletion / privacy:
 *   - PARENT account deleted:
 *       for each device they own (devices.ownerParentUid == uid):
 *         remove devices/{id}/parents/{uid}
 *         if NO parents remain:
 *           → revoke the child device identity's custom claims (unpair)
 *           → delete children/{childUid} when it points at this device
 *           → recursively delete devices/{id} (all telemetry, commands,
 *             sessions, audit) — data minimization on departure
 *           (if the recursive delete fails, the device is tombstoned as
 *            UNPAIRED with purgeScheduledAt and retentionPurge finishes it)
 *         else: audit PARENT_REMOVED_FROM_DEVICE (device stays for the
 *           remaining co-parent)
 *       delete children where parentUid == uid (orphaned links)
 *       invalidate/delete the parent's unused pairing codes
 *       delete users/{uid}
 *   - CHILD DEVICE identity deleted:
 *       unpair its device (status=UNPAIRED, fcmToken removed) — the device
 *       must be re-paired with a fresh code to resume reporting.
 *
 * Everything is audited to the platform-wide log BEFORE deletion happens
 * where possible (the top-level mirror survives the user's own data purge
 * only while the family still has devices; otherwise it decays naturally
 * via the 365-day retention purge).
 */

import * as functionsV1 from "firebase-functions/v1";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { db } from "../lib/verify";
import { writeAudit } from "../lib/audit";

/**
 * v1 SDK note: the user-delete AUTH trigger only exists in the v1 API
 * (firebase-functions/v1 auth user().onDelete). The v2 identity module ships
 * blocking functions only. v1 auth triggers are single-region (us-central1).
 */
export const onUserDeleted = functionsV1
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .auth.user()
  .onDelete(async (user) => {
    const uid = user.uid;
    const claims = (user.customClaims ?? {}) as Record<string, unknown>;

    /* ---------------- child device identity deleted ------------------ */
    if (
      claims["deviceRole"] === "childDevice" &&
      typeof claims["deviceId"] === "string"
    ) {
      const deviceId = claims["deviceId"] as string;
      await unpairChild(deviceId, uid);
      await writeAudit({
        functionName: "onUserDeleted",
        actorUid: "system",
        actorType: "SYSTEM",
        deviceId,
        action: "DEVICE_UNPAIRED",
        result: "INFO",
        details: { reason: "child_identity_deleted", childUid: uid },
      });
      return;
    }

    /* ---------------- parent account deletion cascade ---------------- */
    const ownedDevices = await db()
      .collection("devices")
      .where("ownerParentUid", "==", uid)
      .get();

    for (const deviceDoc of ownedDevices.docs) {
      const deviceId = deviceDoc.id;
      await db().doc(`devices/${deviceId}/parents/${uid}`).delete().catch(() => {});

      const remaining = await db()
        .collection(`devices/${deviceId}/parents`)
        .count()
        .get();

      if ((remaining.data().count ?? 0) === 0) {
        // Last parent is gone: unpair the device and purge its data.
        const childUid = deviceDoc.get("childUid");
        if (typeof childUid === "string" && childUid.length > 0) {
          try {
            await getAuth().setCustomUserClaims(childUid, {}); // revoke claims
          } catch {
            // Identity may already be gone — continue with data purge.
          }
          const childRef = db().doc(`children/${childUid}`);
          const childSnap = await childRef.get();
          if (childSnap.exists && childSnap.get("deviceId") === deviceId) {
            await childRef.delete().catch(() => {});
          }
        }
        try {
          // Recursive delete removes the device doc and ALL subcollections
          // (locations, usage, commands, sessions, audit, …).
          await db().recursiveDelete(deviceDoc.ref);
        } catch (err) {
          // Tombstone for retentionPurge to finish the job on the next run.
          await deviceDoc.ref
            .update({
              status: "UNPAIRED",
              fcmToken: FieldValue.delete(),
              purgeScheduledAt: FieldValue.serverTimestamp(),
            })
            .catch(() => {});
          console.error(
            JSON.stringify({
              severity: "ERROR",
              message: "device_recursive_delete_failed",
              deviceId,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        await writeAudit({
          functionName: "onUserDeleted",
          actorUid: "system",
          actorType: "SYSTEM",
          action: "DEVICE_PURGED_ON_PARENT_DELETE",
          result: "INFO",
          details: { deviceId, deletedBy: uid },
        });
      } else {
        await writeAudit({
          functionName: "onUserDeleted",
          actorUid: "system",
          actorType: "SYSTEM",
          deviceId,
          action: "PARENT_REMOVED_FROM_DEVICE",
          result: "INFO",
          details: { removedParentUid: uid },
        });
      }
    }

    /* ---------------- orphaned child links --------------------------- */
    const kidLinks = await db()
      .collection("children")
      .where("parentUid", "==", uid)
      .get();
    const kidWriter = db().bulkWriter();
    kidLinks.forEach((doc) => kidWriter.delete(doc.ref));
    await kidWriter.close();

    /* ---------------- unused pairing codes --------------------------- */
    const codes = await db()
      .collection("pairingCodes")
      .where("parentUid", "==", uid)
      .get();
    const codeWriter = db().bulkWriter();
    codes.forEach((doc) => codeWriter.delete(doc.ref));
    await codeWriter.close();

    /* ---------------- profile document ------------------------------- */
    await db().doc(`users/${uid}`).delete().catch(() => {});

    await writeAudit({
      functionName: "onUserDeleted",
      actorUid: "system",
      actorType: "SYSTEM",
      action: "ACCOUNT_DELETED",
      result: "INFO",
      details: { uid, devicesAffected: ownedDevices.size },
    });
    }
  );

/** Marks a device unpaired after its child identity disappeared. */
async function unpairChild(deviceId: string, childUid: string): Promise<void> {
  const deviceRef = db().doc(`devices/${deviceId}`);
  const snap = await deviceRef.get().catch(() => null);
  if (!snap || !snap.exists) return;
  if (snap.get("childUid") && snap.get("childUid") !== childUid) return;
  await deviceRef
    .update({
      status: "UNPAIRED",
      fcmToken: FieldValue.delete(),
      childUid: null,
      unpairedAt: FieldValue.serverTimestamp(),
    })
    .catch(() => {});
}
