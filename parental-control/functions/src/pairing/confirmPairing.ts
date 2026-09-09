/**
 * confirmPairing.ts — callable: the CHILD DEVICE consumes a pairing code.
 *
 * Who calls it: the child Android device, signed in with its own Firebase
 * Auth identity (anonymous/device account). The child generates its own
 * deviceId as a UUID (v4) locally — IMEI / serial numbers are rejected.
 *
 * Authorization: the pairing CODE is the shared secret. The function runs a
 * Firestore transaction that:
 *   1. Loads pairingCodes/{code} — must exist, not expired, not used.
 *   2. Is idempotent for retries: if THIS device+uid already consumed the
 *      code but custom-claim setting failed previously, we re-apply claims
 *      and return success instead of failing forever.
 *   3. Rejects devices already bound to another child identity or another
 *      parent (prevents device takeover by a second code).
 *   4. Creates, atomically:
 *        devices/{deviceId}                    { deviceId, ownerParentUid,
 *                                                childUid, status, pairedAt,
 *                                                policyVersion: 1, ... }
 *        devices/{deviceId}/parents/{parentUid}  (pairing link — the ONLY
 *                                                thing requireParent trusts)
 *        children/{childUid}                     (child ↔ device ↔ parent)
 *   5. Marks the code used (single-use; replay impossible).
 *   6. Sets custom claims on the caller:
 *        { deviceRole: "childDevice", deviceId }
 *      → this is what firestore.rules' isChildDevice() checks, granting the
 *        device identity its narrow telemetry-write rights and nothing else.
 *   7. Audits PAIR_DEVICE.
 *
 * Guard: a caller that already owns a parent profile (users/{uid} exists with
 * role=parent) is refused — pairing must be confirmed from the child device,
 * never from a parent account.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import {
  assertAppCheck,
  db,
  enforceRateLimit,
  optionalString,
  requireDeviceId,
  requirePairingCode,
  requireSignedIn,
} from "../lib/verify";
import { writeAudit } from "../lib/audit";
import { REGION } from "../lib/constants";
import { ensureChildDek, isKekConfigured } from "../lib/backupKey";

export const confirmPairing = onCall(
  { region: REGION, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    const uid = requireSignedIn(request);
    assertAppCheck(request);
    await enforceRateLimit(
      `confirm-pairing:${uid}`,
      { max: 20, windowMs: 60 * 60 * 1000 },
      "Too many pairing attempts. Please wait."
    );

    const data = (request.data ?? {}) as Record<string, unknown>;
    const code = requirePairingCode(data["code"]);
    const deviceId = requireDeviceId(data["deviceId"]);
    const deviceName = optionalString(data["deviceName"], "deviceName", 64);

    // Guard: parents must pair from the child device app.
    const callerProfile = await db().doc(`users/${uid}`).get();
    if (callerProfile.exists && callerProfile.get("role") === "parent") {
      throw new HttpsError(
        "failed-precondition",
        "Pairing must be confirmed from the child device app, not from a parent account."
      );
    }

    // Idempotent retry path (see header): claims may have failed last time.
    const preSnap = await db().doc(`pairingCodes/${code}`).get();
    if (
      preSnap.exists &&
      preSnap.get("used") === true &&
      preSnap.get("usedByDeviceId") === deviceId &&
      preSnap.get("usedByChildUid") === uid
    ) {
      await setDeviceClaims(uid, deviceId);
      return {
        deviceId,
        parentUid: preSnap.get("parentUid"),
        pairedAt: Date.now(),
        retried: true,
      };
    }

    const parentUid = await runPairingTransaction(code, deviceId, uid, deviceName);

    // Claims OUTSIDE the transaction: if this fails the device retries the
    // callable and hits the idempotent branch above (code already used by us).
    await setDeviceClaims(uid, deviceId);

    // v1.3.0 — provision the child's backup DEK escrow (best-effort: when
    // BACKUP_KEK is not configured the backup feature reports UNAVAILABLE
    // later instead of failing pairing). The key is stored WRAPPED in
    // Firestore (see lib/backupKey.ts); plaintext never persists.
    if (isKekConfigured()) {
      await ensureChildDek(uid).catch((err) => {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: "backup_dek_provision_failed",
            childUid: uid,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      });
    }

    await writeAudit({
      functionName: "confirmPairing",
      actorUid: uid,
      actorType: "DEVICE",
      deviceId,
      action: "PAIR_DEVICE",
      result: "ALLOWED",
      details: { parentUid, deviceName: deviceName ?? null },
    });

    return { deviceId, parentUid, pairedAt: Date.now() };
  }
);

/* ------------------------------------------------------------------ */

async function runPairingTransaction(
  code: string,
  deviceId: string,
  childUid: string,
  deviceName?: string
): Promise<string> {
  return db().runTransaction(async (tx: Transaction) => {
    const codeRef = db().doc(`pairingCodes/${code}`);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) {
      throw new HttpsError("not-found", "Invalid pairing code.");
    }
    const codeData = codeSnap.data()!;
    if (codeData["used"] === true) {
      throw new HttpsError(
        "failed-precondition",
        "This pairing code was already used."
      );
    }
    const expiresAt = codeData["expiresAt"];
    if (
      !expiresAt ||
      typeof expiresAt.toMillis !== "function" ||
      expiresAt.toMillis() < Date.now()
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This pairing code has expired. Ask the parent to generate a new one."
      );
    }
    const parentUid = codeData["parentUid"] as string;

    const deviceRef = db().doc(`devices/${deviceId}`);
    const deviceSnap = await tx.get(deviceRef);
    if (deviceSnap.exists) {
      const existing = deviceSnap.data()!;
      // Takeover protection: a bound device can never be re-bound elsewhere.
      if (existing["childUid"] && existing["childUid"] !== childUid) {
        throw new HttpsError(
          "already-exists",
          "This device is already paired to another child identity."
        );
      }
      if (
        existing["ownerParentUid"] &&
        existing["ownerParentUid"] !== parentUid
      ) {
        throw new HttpsError(
          "permission-denied",
          "This device is already paired to another parent."
        );
      }
    }

    // 1. Device document (create or merge).
    tx.set(
      deviceRef,
      {
        deviceId,
        ownerParentUid: parentUid,
        childUid,
        deviceName: deviceName ?? "Child device",
        status: "ACTIVE",
        pairedAt: deviceSnap.exists
          ? deviceSnap.data()!["pairedAt"] ?? FieldValue.serverTimestamp()
          : FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        fcmToken: null,
        appVersion: null,
        permissions: null,
        policyVersion: deviceSnap.exists
          ? deviceSnap.data()!["policyVersion"] ?? 1
          : 1,
        policyVersionAcknowledged: null,
      },
      { merge: true }
    );

    // 2. Parent link — the ONLY artifact requireParent() / isParentOf() trust.
    tx.set(deviceRef.collection("parents").doc(parentUid), {
      parentUid,
      role: "parent",
      pairedAt: FieldValue.serverTimestamp(),
      addedBy: "pairing",
    });

    // 3. Child linkage.
    tx.set(
      db().doc(`children/${childUid}`),
      {
        childUid,
        deviceId,
        parentUid,
        displayName: deviceName ?? "Child",
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 4. Single-use: mark consumed.
    tx.update(codeRef, {
      used: true,
      usedByDeviceId: deviceId,
      usedByChildUid: childUid,
      usedAt: FieldValue.serverTimestamp(),
    });

    return parentUid;
  });
}

/** Sets the custom claims that turn this auth uid into a device identity. */
async function setDeviceClaims(uid: string, deviceId: string): Promise<void> {
  await getAuth().setCustomUserClaims(uid, {
    deviceRole: "childDevice",
    deviceId,
  });
  // The device must call getIdToken(true) to pick up claims; documented in
  // docs/architecture.md and enforced implicitly (rules deny until refresh).
}
