/**
 * backup.ts — consent-based automatic cloud backup (v1.3.0) callables.
 *
 * FLOW (Photos/Videos/Contacts/SMS are identical at the protocol layer):
 *   1. Android app detects new media/contacts/SMS (ContentObserver +
 *      WorkManager reconcile), creates devices/{id}/backupItems/{itemId}
 *      with state=PENDING and a DETERMINISTIC itemId
 *      (= sha256(category | sourceKey) — a second detection of the same
 *      content maps to the SAME id, so duplicate backups are impossible
 *      by construction, not just by convention).
 *   2. UploadWorker asks backupCreateUploadUrl → the function RE-VERIFIES
 *      (App Check + device claims + ban state + parent policy + child
 *      consent) for that exact item. Any policy change therefore stops
 *      queued uploads at the server, even if the device was offline and
 *      never saw the toggle (requirement: server pre-check).
 *      → OK: presigned PUT (10 min) + server-generated r2Key; item → UPLOADING
 *      → BLOCKED: item → CANCELLED (policy) — resumable when re-enabled.
 *   3. Device encrypts (AES-256-GCM streaming) and PUTs to R2 (private).
 *   4. backupCompleteUpload HEAD-verifies the object EXISTS in R2 before
 *      allowing UPLOADED + writes stats + child backupIndex.
 *      → a device can never fake a successful backup.
 *   5. Parent views/restores via backupGetDownloadUrl (5-min GET) +
 *      backupGetKey (DEK unwrap, reason="restore", audited).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO:
 *  - It never receives plaintext backup content (encryption is end-to-end
 *    from the device to R2; Firestore holds metadata only).
 *  - It never logs file names, contact names, phone numbers or SMS content
 *    — audits carry item IDs and sizes only.
 */

import {onCall, HttpsError} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import {
  assertAppCheck,
  db,
  enforceRateLimit,
  requireSignedIn,
} from "../lib/verify";
import {writeAudit} from "../lib/audit";
import {presignR2, r2ConfigFromEnv, r2HeadObject} from "../lib/r2";
import {unwrapChildDek} from "../lib/backupKey";
import {
  BACKUP_CATEGORIES,
  BACKUP_DOWNLOAD_RATE_LIMIT,
  BACKUP_DOWNLOAD_URL_TTL_SECONDS,
  BACKUP_KEY_RATE_LIMIT,
  BACKUP_UPLOAD_RATE_LIMIT,
  BACKUP_UPLOAD_URL_TTL_SECONDS,
  REGION,
  R2_ACCESS_KEY_ID_PARAM,
  R2_ACCOUNT_ID_PARAM,
  R2_BUCKET_PARAM,
  R2_SECRET_ACCESS_KEY_PARAM,
} from "../lib/constants";

/** Secrets declared for the backup callables (Secret Manager). */
const r2Secrets = [
  R2_ACCOUNT_ID_PARAM,
  R2_ACCESS_KEY_ID_PARAM,
  R2_SECRET_ACCESS_KEY_PARAM,
  R2_BUCKET_PARAM,
];

/* ------------------------------------------------------------ helpers --- */

interface Caller {
  uid: string;
  role: "parent" | "device";
  deviceId?: string;
}

/**
 * Identity gate shared by all backup callables: signed in + App Check +
 * role resolution. Device role comes from custom claims set ONLY by
 * confirmPairing; parent role from the users/{uid} profile.
 */
async function identifyBackupCaller(
  request: Parameters<typeof requireSignedIn>[0]
): Promise<Caller> {
  const uid = requireSignedIn(request);
  assertAppCheck(request);
  const token = (request.auth?.token ?? {}) as Record<string, unknown>;

  if (token["deviceRole"] === "childDevice" && typeof token["deviceId"] === "string") {
    return {uid, role: "device", deviceId: token["deviceId"] as string};
  }

  const profile = await db().doc(`users/${uid}`).get();
  if (profile.exists && profile.get("role") === "parent") {
    return {uid, role: "parent"};
  }
  throw new HttpsError("permission-denied", "Caller has no backup role.");
}

/** Device-only gate: claims.deviceId must equal the addressed deviceId. */
function requireDeviceCaller(caller: Caller, deviceId: string): void {
  if (caller.role !== "device" || !caller.deviceId || caller.deviceId !== deviceId) {
    throw new HttpsError(
      "permission-denied",
      "This operation is restricted to the paired device itself."
    );
  }
}

/** Parent-of-device gate (mirror of verify.requireParent, lighter shape). */
async function requireParentCaller(caller: Caller, deviceId: string): Promise<void> {
  if (caller.role !== "parent") {
    throw new HttpsError("permission-denied", "Parent authorization required.");
  }
  const link = await db().doc(`devices/${deviceId}/parents/${caller.uid}`).get();
  if (!link.exists) {
    throw new HttpsError("permission-denied", "You are not a paired parent of this device.");
  }
}

/**
 * v1.4.0 — cloud backup is a PREMIUM-only feature. All parent-initiated
 * backup actions (policy change, key unwrap for restore, download URL)
 * require users/{uid}.plan == "premium". Device-side upload completion
 * stays ungated so queued uploads drain safely after a downgrade.
 */
async function requirePremiumParent(uid: string): Promise<void> {
  const snap = await db().doc(`users/${uid}`).get();
  if (!snap.exists || snap.get("plan") !== "premium") {
    await writeAudit({
      functionName: "backupPlanGate",
      actorUid: uid,
      actorType: "PARENT",
      action: "BACKUP_PREMIUM_REQUIRED",
      result: "DENIED",
      details: {reason: "plan_not_premium"},
    });
    throw new HttpsError(
      "permission-denied",
      "Cloud backup requires a premium plan."
    );
  }
}

/** True when the device doc is flagged banned (Developer Admin ban system). */
async function isDeviceBanned(deviceId: string): Promise<boolean> {
  const snap = await db().doc(`devices/${deviceId}`).get();
  return snap.exists && snap.get("banned") === true;
}

function requireItemId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{32,64}$/.test(value)) {
    throw new HttpsError(
      "invalid-argument",
      'Field "itemId" must be a hex content-hash id.'
    );
  }
  return value.toLowerCase();
}

/** Policy + consent + ban gate shared by upload-path callables. */
async function evaluateEligibility(
  deviceId: string,
  category: string
): Promise<{eligible: boolean; reason?: string}> {
  if (!(BACKUP_CATEGORIES as readonly string[]).includes(category)) {
    return {eligible: false, reason: "BAD_CATEGORY"};
  }
  if (await isDeviceBanned(deviceId)) return {eligible: false, reason: "DEVICE_BANNED"};

  const policySnap = await db().doc(`devices/${deviceId}/backupPolicy/current`).get();
  const categories = (policySnap.exists ? policySnap.get("categories") : null) as
    | Record<string, {enabled?: boolean}>
    | null;
  if (!categories || categories[category]?.enabled !== true) {
    return {eligible: false, reason: "POLICY_DISABLED"};
  }

  const consentSnap = await db().doc(`devices/${deviceId}/backupConsent/current`).get();
  const consent = (consentSnap.exists ? consentSnap.get("consent") : null) as
    | Record<string, {granted?: boolean}>
    | null;
  if (!consent || consent[category]?.granted !== true) {
    return {eligible: false, reason: "CONSENT_MISSING"};
  }
  return {eligible: true};
}

/* ------------------------------------------- backupSetPolicy (parent) --- */

/**
 * Parent-side per-category switches. Direct Firestore writes to
 * backupPolicy are DENIED by rules — this callable is the only writer,
 * which makes every toggle authenticated, validated, versioned and
 * audit-logged in one place.
 */
export const backupSetPolicy = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
    if (!/^[0-9a-fA-F-]{10,64}$/.test(deviceId)) {
      throw new HttpsError("invalid-argument", 'Field "deviceId" is malformed.');
    }
    await requireParentCaller(caller, deviceId);
    await requirePremiumParent(caller.uid);
    await enforceRateLimit(
      `backup-policy:${caller.uid}`,
      {max: 60, windowMs: 60 * 60 * 1000},
      "Too many policy changes. Please wait a moment."
    );

    const incoming = data["categories"];
    if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
      throw new HttpsError("invalid-argument", 'Field "categories" must be an object.');
    }
    const patch: Record<string, {enabled: boolean}> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (!(BACKUP_CATEGORIES as readonly string[]).includes(k)) {
        throw new HttpsError("invalid-argument", `Unknown backup category "${k}".`);
      }
      if (typeof v !== "boolean") {
        throw new HttpsError("invalid-argument", `Category "${k}" must be boolean.`);
      }
      patch[k] = {enabled: v};
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpsError("invalid-argument", 'Field "categories" must not be empty.');
    }

    const ref = db().doc(`devices/${deviceId}/backupPolicy/current`);
    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? snap.data() : null;
      const prevCategories = (prev?.["categories"] ?? {}) as Record<string, unknown>;
      const mergedCategories: Record<string, {enabled: boolean}> = {};
      for (const cat of BACKUP_CATEGORIES) {
        const existing = prevCategories[cat] as {enabled?: boolean} | undefined;
        mergedCategories[cat] = {enabled: existing?.enabled === true};
      }
      for (const [k, v] of Object.entries(patch)) mergedCategories[k] = v;
      const version = (typeof prev?.["version"] === "number" ? prev["version"] : 0) + 1;
      const doc = {
        version,
        categories: mergedCategories,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: caller.uid,
      };
      tx.set(ref, doc, {merge: false});
      return {version, categories: mergedCategories};
    });

    await writeAudit({
      functionName: "backupSetPolicy",
      actorUid: caller.uid,
      actorType: "PARENT",
      deviceId,
      action: "BACKUP_POLICY_CHANGE",
      result: "ALLOWED",
      details: {patch, version: result.version},
    });
    return {ok: true, version: result.version, categories: result.categories};
  }
);

/* -------------------------------------------- backupGetKey (dual role) --- */

/**
 * Returns the child's DEK to an authorized caller:
 *   device  → claims.deviceId belongs to that child (encryption at upload)
 *   parent  → paired to at least one device of that child (restore/view)
 * Every call is rate-limited and audit-logged (key access is a sensitive
 * event; the audit row never contains key material itself).
 */
export const backupGetKey = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const childUid = typeof data["childUid"] === "string" ? data["childUid"] : "";
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(childUid)) {
      throw new HttpsError("invalid-argument", 'Field "childUid" is malformed.');
    }
    const reason = data["reason"] === "restore" ? "restore" : "upload";
    await enforceRateLimit(
      `backup-key:${caller.uid}`,
      BACKUP_KEY_RATE_LIMIT,
      "Too many key requests. Please wait."
    );

    if (caller.role === "device") {
      const devSnap = await db().doc(`devices/${caller.deviceId}`).get();
      if (!devSnap.exists || devSnap.get("childUid") !== childUid) {
        throw new HttpsError("permission-denied", "Device does not belong to this child.");
      }
    } else {
      // Parent: paired to at least one device of this child — and premium
      // (v1.4.0: restore/key access is a premium capability).
      await requirePremiumParent(caller.uid);
      const devices = await db()
        .collection("devices")
        .where("childUid", "==", childUid)
        .limit(10)
        .get();
      let linked = false;
      for (const d of devices.docs) {
        const link = await d.ref.collection("parents").doc(caller.uid).get();
        if (link.exists) {
          linked = true;
          break;
        }
      }
      if (!linked) {
        throw new HttpsError("permission-denied", "You are not linked to this child.");
      }
    }

    const {keyB64, keyVersion} = await unwrapChildDek(childUid);
    await writeAudit({
      functionName: "backupGetKey",
      actorUid: caller.uid,
      actorType: caller.role === "device" ? "DEVICE" : "PARENT",
      deviceId: caller.deviceId,
      action: "BACKUP_KEY_ACCESS",
      result: "ALLOWED",
      details: {childUid, reason, keyVersion},
    });
    return {keyB64, keyVersion};
  }
);

/* ------------------------------------- backupCreateUploadUrl (device) --- */

/**
 * The server-side policy checkpoint for every queued upload (requirement:
 * "queued upload actual upload-এর আগে server policy check করে stop করবে").
 * Issues a presigned PUT bound to a SERVER-GENERATED object key — clients
 * can never choose (or guess) where another family's data lives.
 */
export const backupCreateUploadUrl = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB", secrets: r2Secrets},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
    const itemId = requireItemId(data["itemId"]);
    requireDeviceCaller(caller, deviceId);
    await enforceRateLimit(
      `backup-upload:${deviceId}`,
      BACKUP_UPLOAD_RATE_LIMIT,
      "Upload rate limit reached. Try again later."
    );

    const itemRef = db().doc(`devices/${deviceId}/backupItems/${itemId}`);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) throw new HttpsError("not-found", "Backup item not found.");
    const item = itemSnap.data()!;
    const category = String(item["category"] ?? "");

    const eligibility = await evaluateEligibility(deviceId, category);
    if (!eligibility.eligible) {
      // Persist the server decision so the dashboard sees CANCELLED (policy),
      // and the device resumes automatically when the category is re-enabled.
      await itemRef.set(
        {
          state: "CANCELLED",
          lastErrorCode: eligibility.reason,
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
      await writeAudit({
        functionName: "backupCreateUploadUrl",
        actorUid: caller.uid,
        actorType: "DEVICE",
        deviceId,
        action: "BACKUP_UPLOAD_BLOCKED",
        result: "DENIED",
        details: {itemId, category, reason: eligibility.reason},
      });
      return {decision: "BLOCKED", reason: eligibility.reason};
    }

    const cfg = r2ConfigFromEnv();
    if (!cfg) {
      await itemRef.set(
        {
          state: "FAILED",
          lastErrorCode: "BACKUP_STORAGE_UNAVAILABLE",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
      throw new HttpsError(
        "failed-precondition",
        "Backup storage is not configured on this deployment."
      );
    }

    // Server-issued key: b/{deviceId}/{category}/{itemId} — no client input.
    const r2Key = `b/${deviceId}/${category}/${itemId}`;
    const uploadUrl = presignR2(cfg, r2Key, "PUT", BACKUP_UPLOAD_URL_TTL_SECONDS);

    await itemRef.set(
      {
        state: "UPLOADING",
        r2Key,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true}
    );
    return {
      decision: "OK",
      uploadUrl,
      r2Key,
      expiresIn: BACKUP_UPLOAD_URL_TTL_SECONDS,
    };
  }
);

/* ------------------------------------- backupCompleteUpload (device) --- */

/**
 * Marks an item UPLOADED only after verifying the ciphertext object really
 * exists in the private bucket (HEAD). Also maintains the device stats doc
 * and the child-level backupIndex (phone-reset restore path).
 */
export const backupCompleteUpload = onCall(
  {region: REGION, timeoutSeconds: 60, memory: "256MiB", secrets: r2Secrets},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
    const itemId = requireItemId(data["itemId"]);
    requireDeviceCaller(caller, deviceId);

    const ivB64 = typeof data["ivB64"] === "string" ? data["ivB64"] : "";
    if (!/^[A-Za-z0-9+/=]{16,32}$/.test(ivB64)) {
      throw new HttpsError("invalid-argument", 'Field "ivB64" is malformed.');
    }

    const itemRef = db().doc(`devices/${deviceId}/backupItems/${itemId}`);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) throw new HttpsError("not-found", "Backup item not found.");
    const item = itemSnap.data()!;
    if (item["state"] !== "UPLOADING" || typeof item["r2Key"] !== "string") {
      throw new HttpsError(
        "failed-precondition",
        "Item is not in UPLOADING state (call backupCreateUploadUrl first)."
      );
    }

    const cfg = r2ConfigFromEnv();
    if (!cfg) throw new HttpsError("failed-precondition", "Backup storage is not configured.");
    const head = await r2HeadObject(cfg, item["r2Key"] as string);
    if (!head.exists) {
      await itemRef.set(
        {
          state: "FAILED",
          lastErrorCode: "R2_OBJECT_MISSING",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
      await writeAudit({
        functionName: "backupCompleteUpload",
        actorUid: caller.uid,
        actorType: "DEVICE",
        deviceId,
        action: "BACKUP_UPLOAD_FAILED",
        result: "ERROR",
        details: {itemId, reason: "R2_OBJECT_MISSING"},
      });
      return {verified: false, reason: "R2_OBJECT_MISSING"};
    }

    const childUid = String(item["childUid"] ?? "");
    const category = String(item["category"] ?? "unknown");
    const sizeBytes = typeof item["sizeBytes"] === "number" ? item["sizeBytes"] : 0;

    await db().runTransaction(async (tx) => {
      tx.update(itemRef, {
        state: "UPLOADED",
        ivB64,
        uploadedAt: FieldValue.serverTimestamp(),
        lastErrorCode: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const statsRef = db().doc(`devices/${deviceId}/backupStats/current`);
      tx.set(
        statsRef,
        {
          totalBytes: FieldValue.increment(sizeBytes),
          [`itemCounts.${category}`]: FieldValue.increment(1),
          [`lastBackupAt.${category}`]: FieldValue.serverTimestamp(),
          lastBackupAtAny: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
      if (childUid) {
        tx.set(
          db().doc(`children/${childUid}/backupIndex/${deviceId}`),
          {
            deviceId,
            childUid,
            lastBackupAt: FieldValue.serverTimestamp(),
            [`itemCounts.${category}`]: FieldValue.increment(1),
            totalBytes: FieldValue.increment(sizeBytes),
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
      }
    });

    await writeAudit({
      functionName: "backupCompleteUpload",
      actorUid: caller.uid,
      actorType: "DEVICE",
      deviceId,
      action: "BACKUP_UPLOADED",
      result: "ALLOWED",
      details: {itemId, category, sizeBytes},
    });
    return {verified: true};
  }
);

/* ------------------------------------ backupGetDownloadUrl (parent) --- */

/** Short-lived private GET for the parent dashboard view/restore flows. */
export const backupGetDownloadUrl = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB", secrets: r2Secrets},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
    const itemId = requireItemId(data["itemId"]);
    await requireParentCaller(caller, deviceId);
    await requirePremiumParent(caller.uid);
    await enforceRateLimit(
      `backup-dl:${caller.uid}`,
      BACKUP_DOWNLOAD_RATE_LIMIT,
      "Too many downloads. Please wait."
    );

    const itemSnap = await db().doc(`devices/${deviceId}/backupItems/${itemId}`).get();
    if (!itemSnap.exists) throw new HttpsError("not-found", "Backup item not found.");
    const item = itemSnap.data()!;
    if (item["state"] !== "UPLOADED" || typeof item["r2Key"] !== "string") {
      throw new HttpsError("failed-precondition", "This backup is not available for download.");
    }

    const cfg = r2ConfigFromEnv();
    if (!cfg) throw new HttpsError("failed-precondition", "Backup storage is not configured.");
    const downloadUrl = presignR2(
      cfg,
      item["r2Key"] as string,
      "GET",
      BACKUP_DOWNLOAD_URL_TTL_SECONDS
    );

    await writeAudit({
      functionName: "backupGetDownloadUrl",
      actorUid: caller.uid,
      actorType: "PARENT",
      deviceId,
      action: "BACKUP_DOWNLOAD_URL",
      result: "ALLOWED",
      details: {itemId, category: String(item["category"] ?? "")},
    });
    return {
      downloadUrl,
      expiresIn: BACKUP_DOWNLOAD_URL_TTL_SECONDS,
      ivB64: typeof item["ivB64"] === "string" ? item["ivB64"] : null,
      mimeType: typeof item["mimeType"] === "string" ? item["mimeType"] : "application/octet-stream",
      fileName: typeof item["fileName"] === "string" ? item["fileName"] : itemId,
    };
  }
);

/* ------------------------------------- backupListForChild (device) --- */

/**
 * Phone-reset restore discovery: the re-paired device (same child uid)
 * lists restorable backup metadata across ALL devices of that child.
 * Metadata only — content stays in R2 and is fetched via presigned GETs.
 */
export const backupListForChild = onCall(
  {region: REGION, timeoutSeconds: 30, memory: "256MiB"},
  async (request) => {
    const caller = await identifyBackupCaller(request);
    const data = (request.data ?? {}) as Record<string, unknown>;
    const childUid = typeof data["childUid"] === "string" ? data["childUid"] : "";
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(childUid)) {
      throw new HttpsError("invalid-argument", 'Field "childUid" is malformed.');
    }
    requireDeviceCaller(caller, caller.deviceId ?? "");
    const devSnap = await db().doc(`devices/${caller.deviceId}`).get();
    if (!devSnap.exists || devSnap.get("childUid") !== childUid) {
      throw new HttpsError("permission-denied", "Device does not belong to this child.");
    }

    const devices = await db()
      .collection("devices")
      .where("childUid", "==", childUid)
      .limit(10)
      .get();

    const items: Array<Record<string, unknown>> = [];
    for (const d of devices.docs) {
      const snap = await d.ref
        .collection("backupItems")
        .where("state", "==", "UPLOADED")
        .limit(300)
        .get();
      for (const it of snap.docs) {
        const v = it.data();
        items.push({
          deviceId: d.id,
          itemId: it.id,
          category: v["category"],
          fileName: v["fileName"],
          mimeType: v["mimeType"],
          sizeBytes: v["sizeBytes"],
          uploadedAt: v["uploadedAt"] ?? null,
          ivB64: v["ivB64"] ?? null,
          checksumSha256: v["checksumSha256"],
        });
      }
    }
    return {items};
  }
);
