/**
 * handlers.ts — every privileged operation of the platform, ported 1:1 from
 * parental-control/functions (same payloads, same responses, same audits).
 *
 * Port map:
 *   generatePairingCode / confirmPairing   ← functions/src/pairing/*
 *   dispatchCommand / commandResult        ← commands/dispatchCommand +
 *                                            commands/onCommandResult (the
 *                                            Firestore trigger becomes an
 *                                            explicit device call — Spark
 *                                            deployments have no triggers)
 *   requestSession / endSession            ← functions/src/sessions/*
 *   sendParentNotification                 ← functions/src/notifications/*
 *   backupSetPolicy / backupGetKey /
 *   backupCreateUploadUrl / backupCompleteUpload /
 *   backupGetDownloadUrl / backupListForChild ← functions/src/backup/backup.ts
 *   adminSetBanState / adminSetPlan        ← functions/src/admin/*
 *   sweep (cron)                           ← cleanupExpired + cleanupSessions
 *                                            + retentionPurge + escalationCheck
 */

import { randomUUID } from "node:crypto";
import {
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import type { FsTransaction } from "./firestore-rest";
import { db, auth, messaging, type Caller, assertAppCheck } from "./admin";
import { ApiError } from "./http";
import { writeAudit } from "./audit";
import {
  clampDurationMs,
  createAndDispatchCommand,
  validateCommandPayload,
  validateCommandType,
  PREMIUM_COMMAND_TYPES,
} from "./commands";
import { getEscalationMinutes, getFcmTokensForUser, pruneFcmTokensForUser } from "./users";
import { buildIceServers } from "./turn";
import { ensureChildDek, isKekConfigured, unwrapChildDek } from "./backupkey";
import { signGet, signPut } from "./backupurls";
import {
  enforceRateLimit,
  optionalString,
  requireDeviceId,
  requirePairingCode,
  requireString,
} from "./validate";
import {
  ADMIN_RATE_LIMIT,
  BACKUP_CATEGORIES,
  BACKUP_DOWNLOAD_RATE_LIMIT,
  BACKUP_DOWNLOAD_URL_TTL_SECONDS,
  BACKUP_KEY_RATE_LIMIT,
  BACKUP_UPLOAD_RATE_LIMIT,
  BACKUP_UPLOAD_URL_TTL_SECONDS,
  COMMAND_RATE_LIMIT,
  DEFAULT_ESCALATION_MINUTES,
  MAX_ACTIVE_PAIRING_CODES_PER_PARENT,
  NOTIFICATION_RATE_LIMIT,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  REMINDER_INTERVAL_MS,
  RETENTION_BATCH_LIMIT,
  RETENTION_DAYS,
  SESSION_COMMAND_TYPES,
  SESSION_RATE_LIMIT,
  SESSION_REQUEST_TTL_MS,
  SESSION_TYPES,
  SessionType,
} from "./constants";
import type { Env } from "./env";

export type Handler = (
  env: Env,
  caller: Caller,
  data: Record<string, unknown>,
  request: Request
) => Promise<unknown>;

/* ═════════════════════════════════ pairing ═══════════════════════════════ */

/** Parent requests a pairing code (rate-limited, capped, single-use, TTL). */
export const generatePairingCode: Handler = async (env, caller, _data) => {
  void env;
  const uid = caller.uid;
  assertAppCheck(caller);

  // IDEMPOTENT: if this parent already has an active (unused, unexpired) code,
  // return it instead of erroring. Repeated clicks / page reloads must never
  // burn the quota or block pairing with "already have N active codes".
  // (Quota is enforced below only when a NEW code would actually be created.)
  // NOTE: equality-only query — needs NO composite Firestore index (orderBy
  // would); we pick the newest by expiresAt in code below.
  const activeQuery = await db()
    .collection("pairingCodes")
    .where("parentUid", "==", uid)
    .where("used", "==", false)
    .limit(MAX_ACTIVE_PAIRING_CODES_PER_PARENT)
    .get();
  const nowMs = Date.now();
  type ActiveCode = { code: string; expiresAt: { toMillis(): number } };
  const activeDocs = activeQuery.docs
    .map((d) => d.data() as { code?: string; expiresAt?: { toMillis(): number } } | undefined)
    .filter((d): d is ActiveCode =>
      !!d && typeof d.code === "string" && !!d.expiresAt && d.expiresAt.toMillis() > nowMs)
    .sort((a, b) => b.expiresAt.toMillis() - a.expiresAt.toMillis());
  if (activeDocs.length > 0) {
    // Newest valid code; the client just shows it with its remaining TTL.
    // (Handler returns the DATA object — the router wraps it as {ok,data}.)
    const best = activeDocs[0]!;
    return {
      code: best.code,
      expiresAt: best.expiresAt.toMillis(),
      ttlSeconds: Math.max(1, Math.floor((best.expiresAt.toMillis() - nowMs) / 1000)),
      reused: true,
    };
  }

  // No active code → creating a new one is rate-limited (anti-abuse).
  // 30/hour: idempotent path above already reuses active codes, so legitimate
  // parents rarely create more than a handful per hour; abuse still capped.
  await enforceRateLimit(
    `pairing-code:${uid}`,
    { max: 30, windowMs: 60 * 60 * 1000 },
    "Too many pairing codes requested. Please wait before trying again."
  );

  const code = await generateUnbiasedCode();
  const expiresAt = Timestamp.fromMillis(Date.now() + PAIRING_CODE_TTL_MS);

  await db().doc(`pairingCodes/${code}`).set({
    code,
    parentUid: uid,
    used: false,
    usedByDeviceId: null,
    usedByChildUid: null,
    usedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  await writeAudit({
    functionName: "generatePairingCode",
    actorUid: uid,
    actorType: "PARENT",
    action: "PAIRING_CODE_GENERATED",
    result: "ALLOWED",
    details: { expiresAt: expiresAt.toMillis() },
  });

  return { code, expiresAt: expiresAt.toMillis(), ttlSeconds: PAIRING_CODE_TTL_MS / 1000 };
};

/**
 * randomBytes-based code. With a 32-symbol alphabet, byte % 32 is UNBIASED
 * because 256 % 32 == 0 (no modulo bias).
 */
async function generateUnbiasedCode(): Promise<string> {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

/** The CHILD DEVICE consumes a pairing code (transactional, single-use). */
export const confirmPairing: Handler = async (env, caller, data) => {
  const uid = caller.uid;
  assertAppCheck(caller);
  await enforceRateLimit(
    `confirm-pairing:${uid}`,
    { max: 20, windowMs: 60 * 60 * 1000 },
    "Too many pairing attempts. Please wait."
  );

  const code = requirePairingCode(data["code"]);
  const deviceId = requireDeviceId(data["deviceId"]);
  const deviceName = optionalString(data["deviceName"], "deviceName", 64);

  // Guard: parents must pair from the child device app.
  // AUTO-HEAL: earlier deploys provisioned users/{uid} role:"parent" for every
  // unpaired caller — including genuine anonymous child devices, whose pairing
  // would then be blocked forever. A profile that carries ONLY default
  // provisioning fields (role/plan/timestamps, free plan, not banned/admin)
  // is stale provisioning — remove it and let pairing proceed. A profile with
  // ANY real parent data (premium plan, ban state, extras) still trips the
  // guard.
  const callerProfile = await db().doc(`users/${uid}`).get();
  if (callerProfile.exists && callerProfile.get("role") === "parent") {
    const d = callerProfile.data() ?? {};
    const defaultOnly = Object.keys(d).every((k) =>
      ["role", "plan", "createdAt", "lastSeenAt", "updatedAt"].includes(k)
    );
    const isStaleProvisioning =
      defaultOnly && d["plan"] === "free" && d["banned"] !== true && d["admin"] !== true;
    if (!isStaleProvisioning) {
      throw new ApiError(
        "failed-precondition",
        "Pairing must be confirmed from the child device app, not from a parent account."
      );
    }
    await db().doc(`users/${uid}`).delete();
  }

  // Idempotent retry path: claims may have failed last time.
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

  // Claims OUTSIDE the transaction: if this fails the device retries and
  // hits the idempotent branch above (code already used by us).
  await setDeviceClaims(uid, deviceId);

  // v1.3.0 — provision the child's backup DEK escrow (best-effort).
  if (isKekConfigured(env)) {
    await ensureChildDek(env, uid).catch((err) => {
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
};

async function runPairingTransaction(
  code: string,
  deviceId: string,
  childUid: string,
  deviceName?: string
): Promise<string> {
  return db().runTransaction(async (tx: FsTransaction) => {
    const codeRef = db().doc(`pairingCodes/${code}`);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) {
      throw new ApiError("not-found", "Invalid pairing code.");
    }
    const codeData = codeSnap.data()!;
    if (codeData["used"] === true) {
      throw new ApiError("failed-precondition", "This pairing code was already used.");
    }
    const expiresAt = codeData["expiresAt"] as { toMillis?: () => number } | null | undefined;
    if (
      !expiresAt ||
      typeof expiresAt.toMillis !== "function" ||
      expiresAt.toMillis() < Date.now()
    ) {
      throw new ApiError(
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
        throw new ApiError(
          "already-exists",
          "This device is already paired to another child identity."
        );
      }
      if (existing["ownerParentUid"] && existing["ownerParentUid"] !== parentUid) {
        throw new ApiError(
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
  await auth().setCustomUserClaims(uid, {
    deviceRole: "childDevice",
    deviceId,
  });
  // The device must call getIdToken(true) to pick up claims.
}

/* ════════════════════════════════ commands ═══════════════════════════════ */

/** Parent dispatches a WHITELISTED command. */
export const dispatchCommand: Handler = async (_env, caller, data) => {
  const deviceId = requireDeviceId(data["deviceId"]);
  const { uid } = (await requireParentGate(deviceId, caller)) as { uid: string };

  // ---- v1.2.0 Developer-Admin ban enforcement (defense in depth) ----
  const [deviceSnap, parentSnap] = await Promise.all([
    db().doc(`devices/${deviceId}`).get(),
    db().doc(`users/${uid}`).get(),
  ]);
  if (deviceSnap.get("banned") === true) {
    await writeAudit({
      functionName: "dispatchCommand",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "COMMAND_BLOCKED_DEVICE_BANNED",
      result: "DENIED",
      details: { reason: "device_banned_by_admin" },
    });
    throw new ApiError(
      "permission-denied",
      "This device is suspended by the platform administrator."
    );
  }
  if (parentSnap.get("banned") === true) {
    await writeAudit({
      functionName: "dispatchCommand",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "COMMAND_BLOCKED_PARENT_BANNED",
      result: "DENIED",
      details: { reason: "parent_banned_by_admin" },
    });
    throw new ApiError(
      "permission-denied",
      "This account is suspended. Contact support to appeal."
    );
  }

  await enforceRateLimit(
    `commands:${uid}`,
    COMMAND_RATE_LIMIT,
    "Command rate limit exceeded (30/hour). Slow down."
  );

  const type = validateCommandType(data["type"]);

  // ---- v1.4.0 Free/Premium plan gate (defense in depth; UI also gates) ----
  if (PREMIUM_COMMAND_TYPES.includes(type) && parentSnap.get("plan") !== "premium") {
    await writeAudit({
      functionName: "dispatchCommand",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "COMMAND_BLOCKED_PLAN",
      result: "DENIED",
      details: { reason: "premium_required", commandType: type },
    });
    throw new ApiError("permission-denied", "This control requires a premium plan.");
  }

  const payload = validateCommandPayload(type, data["payload"]);

  const { commandId, expiresAt, fcmSent } = await createAndDispatchCommand({
    deviceId,
    createdBy: uid,
    type,
    payload,
  });

  await writeAudit({
    functionName: "dispatchCommand",
    actorUid: uid,
    actorType: "PARENT",
    deviceId,
    action: "COMMAND_DISPATCH",
    result: "ALLOWED",
    details: { commandId, type, fcmSent, expiresAt: expiresAt.toMillis() },
  });

  return { commandId, status: "PENDING", expiresAt: expiresAt.toMillis(), fcmSent };
};

/** Parent-of-device gate shared by parent handlers. */
async function requireParentGate(
  deviceId: string,
  caller: Caller
): Promise<{ uid: string }> {
  assertAppCheck(caller);
  if (caller.kind === "device") {
    throw new ApiError(
      "permission-denied",
      "Device identities cannot call parent operations."
    );
  }
  const link = await db().doc(`devices/${deviceId}/parents/${caller.uid}`).get();
  if (!link.exists) {
    throw new ApiError("permission-denied", "You are not a paired parent of this device.");
  }
  return { uid: caller.uid };
}

/**
 * Device reports a command result — the Spark replacement for the
 * onCommandResult Firestore trigger. Marks the command EXECUTED/FAILED
 * (single-use, replay-protected) and drives the session consent machine.
 * The device ALSO writes its commandResults doc (rules-permitted) for the
 * device-local trail; this endpoint owns the parent-facing command doc.
 *
 * Status mapping (Android CommandResultStatus):
 *   EXECUTED → EXECUTED      FAILED → FAILED
 *   USER_ACCEPTED → EXECUTED + consent GRANTED (session → ACTIVE)
 *   USER_DECLINED → FAILED   + consent DENIED  (session → DENIED)
 *   UNSUPPORTED/REJECTED → FAILED (no session linkage)
 *   PENDING_USER_CONSENT → no state change (follow-up comes later)
 */
export const commandResult: Handler = async (_env, caller, data) => {
  assertAppCheck(caller);
  if (caller.kind !== "device" || !caller.deviceId) {
    throw new ApiError(
      "permission-denied",
      "Only the paired child device may report command results."
    );
  }
  const deviceId = caller.deviceId;

  const commandId = typeof data["commandId"] === "string" ? data["commandId"] : "";
  if (!/^[0-9a-fA-F-]{16,64}$/.test(commandId)) {
    throw new ApiError("invalid-argument", 'Field "commandId" is malformed.');
  }
  const rawStatus = typeof data["status"] === "string" ? data["status"] : "EXECUTED";
  const result =
    typeof data["result"] === "object" && data["result"] !== null
      ? (data["result"] as Record<string, unknown>)
      : ({});

  // PENDING_USER_CONSENT is informational — the consent follow-up
  // (USER_ACCEPTED / USER_DECLINED) drives the state machine later.
  if (rawStatus === "PENDING_USER_CONSENT") {
    return { ok: true, pending: true };
  }

  const consent =
    rawStatus === "USER_ACCEPTED"
      ? "GRANTED"
      : rawStatus === "USER_DECLINED"
        ? "DENIED"
        : undefined;
  const finalStatus = rawStatus === "FAILED" || rawStatus === "USER_DECLINED" ||
      rawStatus === "UNSUPPORTED" || rawStatus === "REJECTED"
    ? "FAILED"
    : "EXECUTED";

  const commandRef = db().doc(`devices/${deviceId}/commands/${commandId}`);
  const commandSnap = await commandRef.get();

  if (!commandSnap.exists) {
    await writeAudit({
      functionName: "commandResult",
      actorUid: `device:${deviceId}`,
      actorType: "DEVICE",
      deviceId,
      action: "COMMAND_RESULT_UNKNOWN",
      result: "ERROR",
      details: { commandId },
    });
    throw new ApiError("not-found", "Unknown command.");
  }

  const command = commandSnap.data()!;

  // Single-use / replay protection.
  const terminalStates = ["EXECUTED", "FAILED", "EXPIRED"];
  if (terminalStates.includes(command["status"] as string)) {
    await writeAudit({
      functionName: "commandResult",
      actorUid: `device:${deviceId}`,
      actorType: "DEVICE",
      deviceId,
      action: "COMMAND_REPLAY_BLOCKED",
      result: "DENIED",
      details: {
        commandId,
        type: command["type"] ?? null,
        previousStatus: command["status"],
      },
    });
    return { ok: true, replay: true };
  }

  await commandRef.update({
    status: finalStatus,
    result: result["message"] ? { message: result["message"] } : result,
    completedAt: FieldValue.serverTimestamp(),
  });

  // Session consent linkage (the ONLY path from device decision → session).
  const commandType = command["type"] as string | undefined;
  const commandPayload = (command["payload"] ?? {}) as Record<string, unknown>;
  const sessionId =
    typeof commandPayload["sessionId"] === "string"
      ? (commandPayload["sessionId"] as string)
      : typeof data["sessionId"] === "string"
        ? (data["sessionId"] as string)
        : null;

  if (
    sessionId &&
    commandType &&
    (SESSION_COMMAND_TYPES as readonly string[]).includes(commandType)
  ) {
    if (commandType.startsWith("STOP_")) {
      await applySessionCommandResult(deviceId, sessionId, commandType, {
        stoppedBy: "CHILD",
        ...result,
      });
    } else if (consent) {
      await applySessionCommandResult(deviceId, sessionId, commandType, {
        consent,
        ...result,
      });
    }
  }

  await writeAudit({
    functionName: "commandResult",
    actorUid: `device:${deviceId}`,
    actorType: "DEVICE",
    deviceId,
    action: "COMMAND_RESULT",
    result: "ALLOWED",
    details: { commandId, type: commandType ?? null, finalStatus, sessionId, consent: consent ?? null },
  });

  return { ok: true };
};

/* ════════════════════════════════ sessions ═══════════════════════════════ */

/** Parent requests a SCREEN/CAMERA/AUDIO session (consent-gated). */
export const requestSession: Handler = async (env, caller, data) => {
  const deviceId = requireDeviceId(data["deviceId"]);
  const { uid } = await requireParentGate(deviceId, caller);

  // ---- v1.4.0 plan gate — ALL live sessions are premium ----
  const profile = await db().doc(`users/${uid}`).get();
  if (profile.get("plan") !== "premium") {
    await writeAudit({
      functionName: "requestSession",
      actorUid: uid,
      actorType: "PARENT",
      deviceId,
      action: "SESSION_REQUEST_BLOCKED_PLAN",
      result: "DENIED",
      details: { reason: "premium_required" },
    });
    throw new ApiError("permission-denied", "Live sessions require a premium plan.");
  }

  await enforceRateLimit(
    `sessions:${uid}`,
    SESSION_RATE_LIMIT,
    "Session request rate limit exceeded (20/hour)."
  );

  const typeRaw = data["type"];
  if (
    typeof typeRaw !== "string" ||
    !(SESSION_TYPES as readonly string[]).includes(typeRaw)
  ) {
    throw new ApiError(
      "invalid-argument",
      `Field "type" must be one of: ${SESSION_TYPES.join(", ")}.`
    );
  }
  const type = typeRaw as SessionType;
  const note = optionalString(data["note"], "note", 200);

  const sessionId = randomUUID();
  const now = Date.now();
  const expiresAt = Timestamp.fromMillis(now + SESSION_REQUEST_TTL_MS);

  await db().doc(`devices/${deviceId}/sessions/${sessionId}`).set({
    sessionId,
    deviceId,
    type,
    requestedBy: uid,
    requestedAt: Timestamp.fromMillis(now),
    state: "REQUESTED",
    expiresAt,
    startedAt: null,
    endedAt: null,
    endReason: null,
    consent: { granted: null, grantedAt: null, deniedAt: null, revokedAt: null },
    permissionState: null,
    iceServers: await buildIceServers(env, sessionId),
    note: note ?? null,
  });

  const commandType = validateCommandType(`REQUEST_${type}_SESSION`);
  const { commandId, fcmSent } = await createAndDispatchCommand({
    deviceId,
    createdBy: uid,
    type: commandType,
    // Consent dialog personalization — the child sees WHO is asking.
    payload: {
      sessionId,
      parentName:
        (typeof profile.get("name") === "string" &&
          (profile.get("name") as string).trim()) ||
        "Your parent",
    },
  });

  await writeAudit({
    functionName: "requestSession",
    actorUid: uid,
    actorType: "PARENT",
    deviceId,
    action: "SESSION_REQUESTED",
    result: "ALLOWED",
    details: { sessionId, type, commandId, fcmSent },
  });

  return { sessionId, commandId, state: "REQUESTED", expiresAt: expiresAt.toMillis(), fcmSent };
};

/** The CHILD DEVICE ends an active/requested session. */
export const endSession: Handler = async (_env, caller, data) => {
  assertAppCheck(caller);
  if (caller.kind !== "device" || !caller.deviceId) {
    throw new ApiError(
      "permission-denied",
      "Only the paired child device may end a session directly. " +
        "Parents should dispatch a STOP_*_SESSION command instead."
    );
  }
  const deviceId = caller.deviceId;
  const uid = caller.uid;

  await enforceRateLimit(
    `end-session:${uid}`,
    { max: 60, windowMs: 60 * 60 * 1000 },
    "Too many session-end requests. Please wait."
  );

  const sessionId = typeof data["sessionId"] === "string" ? data["sessionId"] : "";
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) {
    throw new ApiError("invalid-argument", 'Field "sessionId" has an invalid shape.');
  }

  const sessionRef = db().doc(`devices/${deviceId}/sessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists) {
    throw new ApiError("not-found", "Unknown session.");
  }

  const state = snap.get("state");
  const serverNow = FieldValue.serverTimestamp();
  if (state === "ACTIVE") {
    await sessionRef.update({
      state: "ENDED",
      endedAt: serverNow,
      endReason: "CHILD_STOPPED",
      "consent.revokedAt": serverNow,
    });
  } else if (state === "REQUESTED") {
    await sessionRef.update({
      state: "EXPIRED",
      endedAt: serverNow,
      endReason: "CHILD_DISMISSED",
    });
  } else {
    return { sessionId, state, changed: false };
  }

  await writeAudit({
    functionName: "endSession",
    actorUid: `device:${deviceId}`,
    actorType: "DEVICE",
    deviceId,
    action: "CHILD_SESSION_ENDED",
    result: "INFO",
    details: { sessionId, previousState: state },
  });

  return { sessionId, state: "ENDED", changed: true };
};

/**
 * Applies a device-reported consent outcome to a session document
 * (port of sessionLifecycle.applySessionCommandResult).
 */
async function applySessionCommandResult(
  deviceId: string,
  sessionId: string,
  commandType: string,
  result: Record<string, unknown>
): Promise<void> {
  const sessionRef = db().doc(`devices/${deviceId}/sessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "session_result_unknown_session",
        deviceId,
        sessionId,
        commandType,
      })
    );
    return;
  }

  const serverNow = FieldValue.serverTimestamp();

  if (commandType.startsWith("REQUEST_") && commandType.endsWith("_SESSION")) {
    const consent =
      result["consent"] === "GRANTED"
        ? "GRANTED"
        : result["consent"] === "DENIED"
          ? "DENIED"
          : "UNANSWERED";

    if (consent === "GRANTED") {
      // PRODUCT RULE: SCREEN sessions have NO duration cap — the child
      // approved with visible consent and the session runs until stop.
      const sessionType = (sessionSnap.get("type") as string) ?? "CAMERA";
      if (sessionType === "SCREEN") {
        await sessionRef.update({
          state: "ACTIVE",
          startedAt: serverNow,
          expiresAt: null,
          "consent.granted": true,
          "consent.grantedAt": serverNow,
          permissionState: result["permissionState"] ?? null,
        });
      } else {
        const durationMs = clampDurationMs(result["durationSeconds"]);
        await sessionRef.update({
          state: "ACTIVE",
          startedAt: serverNow,
          expiresAt: Timestamp.fromMillis(Date.now() + durationMs),
          "consent.granted": true,
          "consent.grantedAt": serverNow,
          permissionState: result["permissionState"] ?? null,
        });
      }
    } else if (consent === "DENIED") {
      await sessionRef.update({
        state: "DENIED",
        endedAt: serverNow,
        endReason: "CHILD_DENIED",
        "consent.granted": false,
        "consent.deniedAt": serverNow,
      });
    } else {
      await sessionRef.update({
        "consent.granted": null,
        permissionState: result["permissionState"] ?? null,
      });
    }
    return;
  }

  if (commandType.startsWith("STOP_")) {
    await sessionRef.update({
      state: "ENDED",
      endedAt: serverNow,
      endReason:
        result["stoppedBy"] === "CHILD" ? "CHILD_STOPPED" : "PARENT_STOPPED",
      "consent.revokedAt": serverNow,
    });
  }
}

/* ════════════════════════════ notifications ══════════════════════════════ */

/** Parent sends a message/notification to the paired child device. */
export const sendParentNotification: Handler = async (_env, caller, data) => {
  const deviceId = requireDeviceId(data["deviceId"]);
  const { uid } = await requireParentGate(deviceId, caller);
  assertAppCheck(caller);

  await enforceRateLimit(
    `notify:${uid}`,
    NOTIFICATION_RATE_LIMIT,
    "Notification rate limit exceeded (60/hour)."
  );

  const title = requireString(data["title"], "title", 100);
  const body = requireString(data["body"], "body", 500);
  const category = optionalString(data["category"], "category", 40) ?? "PARENT_MESSAGE";

  const notificationId = randomUUID();
  await db().doc(`devices/${deviceId}/notifications/${notificationId}`).set({
    notificationId,
    deviceId,
    type: "PARENT_MESSAGE",
    category,
    title,
    body,
    sentBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    read: false,
    deliveredAt: null,
  });

  const deviceSnap = await db().doc(`devices/${deviceId}`).get();
  const token = deviceSnap.get("fcmToken");
  let fcmSent = false;
  if (typeof token === "string" && token.length > 0) {
    try {
      await messaging().send({
        token,
        data: { kind: "NOTIFICATION", notificationId, title, body, category },
        android: { priority: "high", collapseKey: "PARENT_MESSAGE" },
      } as never);
      fcmSent = true;
      await db()
        .doc(`devices/${deviceId}/notifications/${notificationId}`)
        .update({ deliveredAt: FieldValue.serverTimestamp() });
    } catch (err) {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: "notification_fcm_failed",
          deviceId,
          notificationId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  await writeAudit({
    functionName: "sendParentNotification",
    actorUid: uid,
    actorType: "PARENT",
    deviceId,
    action: "NOTIFICATION_SENT",
    result: "ALLOWED",
    details: { notificationId, category, fcmSent },
  });

  return { notificationId, fcmSent };
};

/* ════════════════════════════════ backup ═════════════════════════════════ */

interface BackupCaller {
  uid: string;
  role: "parent" | "device";
  deviceId?: string;
}

/** Identity gate shared by all backup handlers. */
async function identifyBackupCaller(caller: Caller): Promise<BackupCaller> {
  assertAppCheck(caller);
  if (caller.kind === "device" && caller.deviceId) {
    return { uid: caller.uid, role: "device", deviceId: caller.deviceId };
  }
  const profile = await db().doc(`users/${caller.uid}`).get();
  if (profile.exists && profile.get("role") === "parent") {
    return { uid: caller.uid, role: "parent" };
  }
  throw new ApiError("permission-denied", "Caller has no backup role.");
}

function requireDeviceCaller(bc: BackupCaller, deviceId: string): void {
  if (bc.role !== "device" || !bc.deviceId || bc.deviceId !== deviceId) {
    throw new ApiError(
      "permission-denied",
      "This operation is restricted to the paired device itself."
    );
  }
}

async function requireParentCaller(bc: BackupCaller, deviceId: string): Promise<void> {
  if (bc.role !== "parent") {
    throw new ApiError("permission-denied", "Parent authorization required.");
  }
  const link = await db().doc(`devices/${deviceId}/parents/${bc.uid}`).get();
  if (!link.exists) {
    throw new ApiError("permission-denied", "You are not a paired parent of this device.");
  }
}

/** v1.4.0 — cloud backup is a PREMIUM-only feature for parent actions. */
async function requirePremiumParent(uid: string): Promise<void> {
  const snap = await db().doc(`users/${uid}`).get();
  if (!snap.exists || snap.get("plan") !== "premium") {
    await writeAudit({
      functionName: "backupPlanGate",
      actorUid: uid,
      actorType: "PARENT",
      action: "BACKUP_PREMIUM_REQUIRED",
      result: "DENIED",
      details: { reason: "plan_not_premium" },
    });
    throw new ApiError("permission-denied", "Cloud backup requires a premium plan.");
  }
}

async function isDeviceBanned(deviceId: string): Promise<boolean> {
  const snap = await db().doc(`devices/${deviceId}`).get();
  return snap.exists && snap.get("banned") === true;
}

function requireItemId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{32,64}$/.test(value)) {
    throw new ApiError(
      "invalid-argument",
      'Field "itemId" must be a hex content-hash id.'
    );
  }
  return value.toLowerCase();
}

/** Policy + consent + ban gate shared by upload-path handlers. */
async function evaluateEligibility(
  deviceId: string,
  category: string
): Promise<{ eligible: boolean; reason?: string }> {
  if (!(BACKUP_CATEGORIES as readonly string[]).includes(category)) {
    return { eligible: false, reason: "BAD_CATEGORY" };
  }
  if (await isDeviceBanned(deviceId)) return { eligible: false, reason: "DEVICE_BANNED" };

  const policySnap = await db().doc(`devices/${deviceId}/backupPolicy/current`).get();
  const categories = (policySnap.exists ? policySnap.get("categories") : null) as
    | Record<string, { enabled?: boolean }>
    | null;
  if (!categories || categories[category]?.enabled !== true) {
    return { eligible: false, reason: "POLICY_DISABLED" };
  }

  const consentSnap = await db().doc(`devices/${deviceId}/backupConsent/current`).get();
  const consent = (consentSnap.exists ? consentSnap.get("consent") : null) as
    | Record<string, { granted?: boolean }>
    | null;
  if (!consent || consent[category]?.granted !== true) {
    return { eligible: false, reason: "CONSENT_MISSING" };
  }
  return { eligible: true };
}

/** Parent-side per-category backup switches (the only writer). */
export const backupSetPolicy: Handler = async (_env, caller, data) => {
  const bc = await identifyBackupCaller(caller);
  const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
  if (!/^[0-9a-fA-F-]{10,64}$/.test(deviceId)) {
    throw new ApiError("invalid-argument", 'Field "deviceId" is malformed.');
  }
  await requireParentCaller(bc, deviceId);
  await requirePremiumParent(bc.uid);
  await enforceRateLimit(
    `backup-policy:${bc.uid}`,
    { max: 60, windowMs: 60 * 60 * 1000 },
    "Too many policy changes. Please wait a moment."
  );

  const incoming = data["categories"];
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    throw new ApiError("invalid-argument", 'Field "categories" must be an object.');
  }
  const patch: Record<string, { enabled: boolean }> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (!(BACKUP_CATEGORIES as readonly string[]).includes(k)) {
      throw new ApiError("invalid-argument", `Unknown backup category "${k}".`);
    }
    if (typeof v !== "boolean") {
      throw new ApiError("invalid-argument", `Category "${k}" must be boolean.`);
    }
    patch[k] = { enabled: v };
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError("invalid-argument", 'Field "categories" must not be empty.');
  }

  const ref = db().doc(`devices/${deviceId}/backupPolicy/current`);
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;
    const prevCategories = (prev?.["categories"] ?? {}) as Record<string, unknown>;
    const mergedCategories: Record<string, { enabled: boolean }> = {};
    for (const cat of BACKUP_CATEGORIES) {
      const existing = prevCategories[cat] as { enabled?: boolean } | undefined;
      mergedCategories[cat] = { enabled: existing?.enabled === true };
    }
    for (const [k, v] of Object.entries(patch)) mergedCategories[k] = v;
    const version = (typeof prev?.["version"] === "number" ? prev["version"] : 0) + 1;
    const doc = {
      version,
      categories: mergedCategories,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: bc.uid,
    };
    tx.set(ref, doc, { merge: false });
    return { version, categories: mergedCategories };
  });

  await writeAudit({
    functionName: "backupSetPolicy",
    actorUid: bc.uid,
    actorType: "PARENT",
    deviceId,
    action: "BACKUP_POLICY_CHANGE",
    result: "ALLOWED",
    details: { patch, version: result.version },
  });
  return { ok: true, version: result.version, categories: result.categories };
};

/** Returns the child's DEK to an authorized device or paired parent. */
export const backupGetKey: Handler = async (env, caller, data) => {
  const bc = await identifyBackupCaller(caller);
  const childUid = typeof data["childUid"] === "string" ? data["childUid"] : "";
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(childUid)) {
    throw new ApiError("invalid-argument", 'Field "childUid" is malformed.');
  }
  const reason = data["reason"] === "restore" ? "restore" : "upload";
  await enforceRateLimit(
    `backup-key:${bc.uid}`,
    BACKUP_KEY_RATE_LIMIT,
    "Too many key requests. Please wait."
  );

  if (bc.role === "device" && bc.deviceId) {
    const devSnap = await db().doc(`devices/${bc.deviceId}`).get();
    if (!devSnap.exists || devSnap.get("childUid") !== childUid) {
      throw new ApiError("permission-denied", "Device does not belong to this child.");
    }
  } else if (bc.role === "parent") {
    await requirePremiumParent(bc.uid);
    const devices = await db()
      .collection("devices")
      .where("childUid", "==", childUid)
      .limit(10)
      .get();
    let linked = false;
    for (const d of devices.docs) {
      const link = await d.ref.collection("parents").doc(bc.uid).get();
      if (link.exists) {
        linked = true;
        break;
      }
    }
    if (!linked) {
      throw new ApiError("permission-denied", "You are not linked to this child.");
    }
  } else {
    throw new ApiError("permission-denied", "Caller has no backup role.");
  }

  if (!isKekConfigured(env)) {
    throw new ApiError(
      "failed-precondition",
      "Backup key escrow is not configured on this deployment."
    );
  }
  const { keyB64, keyVersion } = await unwrapChildDek(env, childUid);
  await writeAudit({
    functionName: "backupGetKey",
    actorUid: bc.uid,
    actorType: bc.role === "device" ? "DEVICE" : "PARENT",
    deviceId: bc.deviceId,
    action: "BACKUP_KEY_ACCESS",
    result: "ALLOWED",
    details: { childUid, reason, keyVersion },
  });
  return { keyB64, keyVersion };
};

/**
 * The server-side policy checkpoint for every queued upload. Issues a
 * signed PUT bound to a SERVER-GENERATED object key — clients can never
 * choose (or guess) where another family's data lives.
 */
export const backupCreateUploadUrl: Handler = async (
  env,
  caller,
  data,
  request
) => {
  const bc = await identifyBackupCaller(caller);
  const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
  const itemId = requireItemId(data["itemId"]);
  requireDeviceCaller(bc, deviceId);
  await enforceRateLimit(
    `backup-upload:${deviceId}`,
    BACKUP_UPLOAD_RATE_LIMIT,
    "Upload rate limit reached. Try again later."
  );

  const itemRef = db().doc(`devices/${deviceId}/backupItems/${itemId}`);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new ApiError("not-found", "Backup item not found.");
  const item = itemSnap.data()!;
  const category = String(item["category"] ?? "");

  const eligibility = await evaluateEligibility(deviceId, category);
  if (!eligibility.eligible) {
    await itemRef.set(
      {
        state: "CANCELLED",
        lastErrorCode: eligibility.reason,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await writeAudit({
      functionName: "backupCreateUploadUrl",
      actorUid: bc.uid,
      actorType: "DEVICE",
      deviceId,
      action: "BACKUP_UPLOAD_BLOCKED",
      result: "DENIED",
      details: { itemId, category, reason: eligibility.reason },
    });
    return { decision: "BLOCKED", reason: eligibility.reason };
  }

  if (!env.BACKUP_BUCKET || !env.BACKUP_URL_SECRET) {
    await itemRef.set(
      {
        state: "FAILED",
        lastErrorCode: "BACKUP_STORAGE_UNAVAILABLE",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new ApiError(
      "failed-precondition",
      "Backup storage is not configured on this deployment."
    );
  }

  // Server-issued key: b/{deviceId}/{category}/{itemId} — no client input.
  const r2Key = `b/${deviceId}/${category}/${itemId}`;
  const signed = await signPut(env, request, r2Key, BACKUP_UPLOAD_URL_TTL_SECONDS);

  await itemRef.set(
    {
      state: "UPLOADING",
      r2Key,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    decision: "OK",
    uploadUrl: signed.url,
    r2Key,
    expiresIn: BACKUP_UPLOAD_URL_TTL_SECONDS,
  };
};

/** Marks UPLOADED only after HEAD-verifying the object exists in R2. */
export const backupCompleteUpload: Handler = async (env, caller, data) => {
  const bc = await identifyBackupCaller(caller);
  const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
  const itemId = requireItemId(data["itemId"]);
  requireDeviceCaller(bc, deviceId);

  const ivB64 = typeof data["ivB64"] === "string" ? data["ivB64"] : "";
  if (!/^[A-Za-z0-9+/=]{16,32}$/.test(ivB64)) {
    throw new ApiError("invalid-argument", 'Field "ivB64" is malformed.');
  }

  const itemRef = db().doc(`devices/${deviceId}/backupItems/${itemId}`);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new ApiError("not-found", "Backup item not found.");
  const item = itemSnap.data()!;
  if (item["state"] !== "UPLOADING" || typeof item["r2Key"] !== "string") {
    throw new ApiError(
      "failed-precondition",
      "Item is not in UPLOADING state (call backupCreateUploadUrl first)."
    );
  }

  if (!env.BACKUP_BUCKET) {
    throw new ApiError("failed-precondition", "Backup storage is not configured.");
  }
  const head = await env.BACKUP_BUCKET.head(item["r2Key"] as string);
  if (!head) {
    await itemRef.set(
      {
        state: "FAILED",
        lastErrorCode: "R2_OBJECT_MISSING",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await writeAudit({
      functionName: "backupCompleteUpload",
      actorUid: bc.uid,
      actorType: "DEVICE",
      deviceId,
      action: "BACKUP_UPLOAD_FAILED",
      result: "ERROR",
      details: { itemId, reason: "R2_OBJECT_MISSING" },
    });
    return { verified: false, reason: "R2_OBJECT_MISSING" };
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
      { merge: true }
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
        { merge: true }
      );
    }
  });

  await writeAudit({
    functionName: "backupCompleteUpload",
    actorUid: bc.uid,
    actorType: "DEVICE",
    deviceId,
    action: "BACKUP_UPLOADED",
    result: "ALLOWED",
    details: { itemId, category, sizeBytes },
  });
  return { verified: true };
};

/** Short-lived signed GET for the parent dashboard view/restore flows. */
export const backupGetDownloadUrl: Handler = async (
  env,
  caller,
  data,
  request
) => {
  const bc = await identifyBackupCaller(caller);
  const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
  const itemId = requireItemId(data["itemId"]);
  await requireParentCaller(bc, deviceId);
  await requirePremiumParent(bc.uid);
  await enforceRateLimit(
    `backup-dl:${bc.uid}`,
    BACKUP_DOWNLOAD_RATE_LIMIT,
    "Too many downloads. Please wait."
  );

  const itemSnap = await db().doc(`devices/${deviceId}/backupItems/${itemId}`).get();
  if (!itemSnap.exists) throw new ApiError("not-found", "Backup item not found.");
  const item = itemSnap.data()!;
  if (item["state"] !== "UPLOADED" || typeof item["r2Key"] !== "string") {
    throw new ApiError("failed-precondition", "This backup is not available for download.");
  }

  if (!env.BACKUP_BUCKET || !env.BACKUP_URL_SECRET) {
    throw new ApiError("failed-precondition", "Backup storage is not configured.");
  }
  const signed = await signGet(
    env,
    request,
    item["r2Key"] as string,
    BACKUP_DOWNLOAD_URL_TTL_SECONDS
  );

  await writeAudit({
    functionName: "backupGetDownloadUrl",
    actorUid: bc.uid,
    actorType: "PARENT",
    deviceId,
    action: "BACKUP_DOWNLOAD_URL",
    result: "ALLOWED",
    details: { itemId, category: String(item["category"] ?? "") },
  });
  return {
    downloadUrl: signed.url,
    expiresIn: BACKUP_DOWNLOAD_URL_TTL_SECONDS,
    ivB64: typeof item["ivB64"] === "string" ? item["ivB64"] : null,
    mimeType: typeof item["mimeType"] === "string" ? item["mimeType"] : "application/octet-stream",
    fileName: typeof item["fileName"] === "string" ? item["fileName"] : itemId,
  };
};

/** Phone-reset restore discovery across ALL devices of this child. */
export const backupListForChild: Handler = async (_env, caller, data) => {
  const bc = await identifyBackupCaller(caller);
  const childUid = typeof data["childUid"] === "string" ? data["childUid"] : "";
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(childUid)) {
    throw new ApiError("invalid-argument", 'Field "childUid" is malformed.');
  }
  requireDeviceCaller(bc, bc.deviceId ?? "");
  const devSnap = await db().doc(`devices/${bc.deviceId}`).get();
  if (!devSnap.exists || devSnap.get("childUid") !== childUid) {
    throw new ApiError("permission-denied", "Device does not belong to this child.");
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
      const v = it.data()!;
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
  return { items };
};

/* ═════════════════════════════════ admin ═════════════════════════════════ */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless the caller token carries the admin custom claim. */
function requireAdmin(caller: Caller): string {
  assertAppCheck(caller);
  if (caller.token["admin"] !== true) {
    throw new ApiError(
      "permission-denied",
      "Admin privileges required. This incident is recorded."
    );
  }
  return caller.uid;
}

/** DEVELOPER ADMIN ban/unban (user | device). */
export const adminSetBanState: Handler = async (_env, caller, data) => {
  const adminUid = requireAdmin(caller);

  await enforceRateLimit(
    `admin:${adminUid}`,
    ADMIN_RATE_LIMIT,
    "Admin action rate limit exceeded. Wait a moment."
  );

  const targetType = data["targetType"];
  if (targetType !== "user" && targetType !== "device") {
    throw new ApiError("invalid-argument", 'Field "targetType" must be "user" or "device".');
  }
  const targetId = data["targetId"];
  if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 128) {
    throw new ApiError("invalid-argument", 'Field "targetId" is invalid.');
  }
  const banned = data["banned"];
  if (typeof banned !== "boolean") {
    throw new ApiError("invalid-argument", 'Field "banned" must be a boolean.');
  }
  const reasonRaw = data["reason"];
  const reason =
    typeof reasonRaw === "string"
      ? reasonRaw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 280)
      : "No reason provided";

  if (targetType === "user") {
    if (targetId === adminUid) {
      throw new ApiError("invalid-argument", "Admins cannot ban themselves.");
    }
    const userRef = db().doc(`users/${targetId}`);
    const snap = await userRef.get();
    if (!snap.exists) {
      throw new ApiError("not-found", "Target user does not exist.");
    }
    if (snap.get("role") === "admin") {
      throw new ApiError("permission-denied", "Admin accounts cannot be banned.");
    }
    await userRef.set(
      {
        banned,
        bannedReason: banned ? reason : FieldValue.delete(),
        bannedAt: banned ? new Date() : FieldValue.delete(),
        bannedBy: banned ? adminUid : FieldValue.delete(),
      },
      { merge: true }
    );
    if (banned) {
      try {
        await auth().revokeRefreshTokens(targetId);
      } catch (err) {
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: "revoke_refresh_tokens_failed",
            targetId,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }
    await writeAudit({
      functionName: "adminSetBanState",
      actorUid: adminUid,
      actorType: "ADMIN",
      action: banned ? "ADMIN_BAN_USER" : "ADMIN_UNBAN_USER",
      result: "ALLOWED",
      details: { targetId, reason },
    });
    return { ok: true, targetType, targetId, banned };
  }

  // --------------------------- device branch ---------------------------
  if (!UUID_RE.test(targetId)) {
    throw new ApiError("invalid-argument", 'Field "targetId" must be a canonical device UUID.');
  }
  const deviceRef = db().doc(`devices/${targetId}`);
  const snap = await deviceRef.get();
  if (!snap.exists) {
    throw new ApiError("not-found", "Target device does not exist.");
  }
  await deviceRef.set(
    {
      banned,
      bannedReason: banned ? reason : FieldValue.delete(),
      bannedAt: banned ? new Date() : FieldValue.delete(),
      bannedBy: banned ? adminUid : FieldValue.delete(),
    },
    { merge: true }
  );
  await writeAudit({
    functionName: "adminSetBanState",
    actorUid: adminUid,
    actorType: "ADMIN",
    action: banned ? "ADMIN_BAN_DEVICE" : "ADMIN_UNBAN_DEVICE",
    result: "ALLOWED",
    deviceId: targetId,
    details: { targetId, reason },
  });
  return { ok: true, targetType, targetId, banned };
};

/** DEVELOPER ADMIN sets a user's plan (free | premium). */
export const adminSetPlan: Handler = async (_env, caller, data) => {
  const adminUid = requireAdmin(caller);

  await enforceRateLimit(
    `admin:${adminUid}`,
    ADMIN_RATE_LIMIT,
    "Admin action rate limit exceeded. Wait a moment."
  );

  const targetUid = data["targetUid"];
  if (typeof targetUid !== "string" || targetUid.length < 8 || targetUid.length > 128) {
    throw new ApiError("invalid-argument", 'Field "targetUid" is malformed.');
  }
  const plan = data["plan"];
  if (plan !== "free" && plan !== "premium") {
    throw new ApiError("invalid-argument", 'Field "plan" must be "free" or "premium".');
  }

  if (targetUid === adminUid) {
    await writeAudit({
      functionName: "adminSetPlan",
      actorUid: adminUid,
      actorType: "ADMIN",
      action: "ADMIN_SET_PLAN",
      result: "DENIED",
      details: { reason: "self_target" },
    });
    throw new ApiError("permission-denied", "You cannot change your own plan.");
  }

  const ref = db().doc(`users/${targetUid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new ApiError("not-found", "Target user does not exist.");
  }
  if (snap.get("role") === "admin") {
    await writeAudit({
      functionName: "adminSetPlan",
      actorUid: adminUid,
      actorType: "ADMIN",
      action: "ADMIN_SET_PLAN",
      result: "DENIED",
      details: { reason: "admin_target", targetUid },
    });
    throw new ApiError("permission-denied", "Admin accounts cannot be re-planned.");
  }

  await ref.set(
    {
      plan,
      planUpdatedAt: FieldValue.serverTimestamp(),
      planUpdatedBy: adminUid,
    },
    { merge: true }
  );

  await writeAudit({
    functionName: "adminSetPlan",
    actorUid: adminUid,
    actorType: "ADMIN",
    action: "ADMIN_SET_PLAN",
    result: "ALLOWED",
    details: { targetUid, plan },
  });

  return { ok: true, targetUid, plan };
};

/** Device subcollections wiped by adminDeleteUser's cascade. */
const DEVICE_SUBCOLLECTIONS = [
  "parents", "commands", "commandResults", "sessions", "signals", "notifications",
  "installedApps", "appUsage", "locations", "emergencyEvents", "backupItems",
  "backupStats", "backupPolicy", "status", "permissions", "policies",
] as const;

/**
 * Deletes every document under one device's known subcollections (REST has
 * no recursive delete — list then batch-delete, bounded per collection).
 */
async function purgeDeviceSubcollections(deviceId: string): Promise<number> {
  const root = db().doc(`devices/${deviceId}`);
  let deleted = 0;
  for (const sub of DEVICE_SUBCOLLECTIONS) {
    try {
      for (let page = 0; page < 20; page++) {
        const snap = await root.collection(sub).limit(450).get();
        if (snap.docs.length === 0) break;
        const writer = db().bulkWriter();
        snap.docs.forEach((d) => writer.delete(d.ref));
        await writer.close();
        deleted += snap.docs.length;
        if (snap.docs.length < 450) break;
      }
    } catch (err) {
      // signals live under sessions/{sid}/signals — handled per-session below.
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "admin_purge_subcollection_failed",
          deviceId,
          sub,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
  // WebRTC signaling envelopes are nested one level deeper (sessions/{sid}/signals).
  try {
    const sessions = await root.collection("sessions").limit(100).get();
    for (const s of sessions.docs) {
      const signals = await s.ref.collection("signals").limit(450).get();
      if (signals.docs.length > 0) {
        const writer = db().bulkWriter();
        signals.docs.forEach((d) => writer.delete(d.ref));
        await writer.close();
        deleted += signals.docs.length;
      }
    }
  } catch {
    /* best-effort */
  }
  return deleted;
}

/**
 * adminListUsers — REAL registered accounts (Firebase Auth) enriched with
 * Firestore profile fields (plan/banned/role) + owned-device counts. Powers
 * the web admin console's "Registered Users" tab (no more demo seed data).
 */
export const adminListUsers: Handler = async (_env, caller, data) => {
  const adminUid = requireAdmin(caller);
  await enforceRateLimit(`admin:${adminUid}`, ADMIN_RATE_LIMIT, "Admin action rate limit exceeded. Wait a moment.");

  const maxResults = Math.min(Math.max(Number(data["maxResults"]) || 500, 1), 1000);
  const pageTokenRaw = typeof data["pageToken"] === "string" ? (data["pageToken"] as string) : undefined;

  const listed = await auth().listUsers(maxResults, pageTokenRaw);
  const uids = listed.users.map((u) => u.uid);

  // Firestore profile enrichment (plan/banned/role) — batched, fault-tolerant.
  const profiles = new Map<string, Record<string, unknown>>();
  await Promise.all(
    uids.map(async (uid) => {
      try {
        const snap = await db().doc(`users/${uid}`).get();
        if (snap.exists) profiles.set(uid, snap.data() as Record<string, unknown>);
      } catch {
        /* profile doc optional */
      }
    })
  );

  // Owned-device counts (IN query in chunks of 10 — Firestore disjunction limit).
  const deviceCounts = new Map<string, number>();
  for (let i = 0; i < uids.length; i += 10) {
    const chunk = uids.slice(i, i + 10);
    if (chunk.length === 0) continue;
    try {
      const snap = await db()
        .collection("devices")
        .where("ownerParentUid", "in", chunk)
        .get();
      snap.docs.forEach((d) => {
        const owner = (d.data() as Record<string, unknown>)["ownerParentUid"];
        if (typeof owner === "string") {
          deviceCounts.set(owner, (deviceCounts.get(owner) ?? 0) + 1);
        }
      });
    } catch {
      /* counts stay 0 on failure */
    }
  }

  return {
    users: listed.users.map((u) => {
      const prof = profiles.get(u.uid) ?? {};
      return {
        uid: u.uid,
        email: u.email ?? "",
        displayName: u.displayName ?? "",
        disabled: u.disabled === true,
        admin: u.customClaims?.["admin"] === true,
        createdAtMs: u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : null,
        lastSignInMs: u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : null,
        plan: prof["plan"] === "premium" ? "premium" : "free",
        banned: prof["banned"] === true,
        role: (prof["role"] as string) ?? null,
        deviceCount: deviceCounts.get(u.uid) ?? 0,
      };
    }),
    total: listed.users.length,
    pageToken: listed.pageToken ?? null,
  };
};

/**
 * adminDeleteUser — FULL account deletion (GDPR-style): removes the Firebase
 * Auth account, every device the parent owns (docs + subcollections), the
 * paired child auth accounts, children/{uid} docs, their users/{uid} profile
 * and any outstanding pairing codes. Irreversible — the web console asks for
 * confirmation before calling this.
 */
export const adminDeleteUser: Handler = async (_env, caller, data) => {
  const adminUid = requireAdmin(caller);
  await enforceRateLimit(`admin:${adminUid}`, ADMIN_RATE_LIMIT, "Admin action rate limit exceeded. Wait a moment.");

  const targetUid = data["targetUid"];
  if (typeof targetUid !== "string" || targetUid.length < 8 || targetUid.length > 128) {
    throw new ApiError("invalid-argument", 'Field "targetUid" is malformed.');
  }
  if (targetUid === adminUid) {
    throw new ApiError("permission-denied", "Admins cannot delete their own account.");
  }

  let authUser;
  try {
    authUser = await auth().getUser(targetUid);
  } catch {
    throw new ApiError("not-found", "Target user does not exist in Firebase Auth.");
  }
  if (authUser.customClaims?.["admin"] === true) {
    throw new ApiError("permission-denied", "Admin accounts cannot be deleted here.");
  }

  const ownedDevices = await db()
    .collection("devices")
    .where("ownerParentUid", "==", targetUid)
    .limit(10)
    .get();

  const childUids: string[] = [];
  let devicesRemoved = 0;
  for (const d of ownedDevices.docs) {
    const v = d.data() as Record<string, unknown>;
    if (typeof v["childUid"] === "string" && v["childUid"]) childUids.push(v["childUid"]);
    await purgeDeviceSubcollections(d.id);
    try {
      await db().doc(`devices/${d.id}`).delete();
      devicesRemoved++;
    } catch (err) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "admin_delete_device_doc_failed",
          deviceId: d.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  // Child auth accounts + children/{uid} profile docs.
  let childUsersRemoved = 0;
  for (const childUid of [...new Set(childUids)]) {
    try {
      await auth().deleteUser(childUid);
      childUsersRemoved++;
    } catch (err) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "admin_delete_child_auth_failed",
          childUid,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    try {
      await db().doc(`children/${childUid}`).delete();
    } catch {
      /* doc may not exist */
    }
  }

  // Outstanding pairing codes minted by this parent.
  try {
    const codes = await db()
      .collection("pairingCodes")
      .where("parentUid", "==", targetUid)
      .limit(20)
      .get();
    if (codes.docs.length > 0) {
      const writer = db().bulkWriter();
      codes.docs.forEach((c) => writer.delete(c.ref));
      await writer.close();
    }
  } catch {
    /* best-effort */
  }

  // Firestore profile doc + the Auth account itself.
  try {
    await db().doc(`users/${targetUid}`).delete();
  } catch {
    /* doc may not exist */
  }
  await auth().deleteUser(targetUid);

  await writeAudit({
    functionName: "adminDeleteUser",
    actorUid: adminUid,
    actorType: "ADMIN",
    action: "ADMIN_DELETE_USER",
    result: "ALLOWED",
    details: { targetUid, email: authUser.email ?? null, devicesRemoved, childUsersRemoved },
  });

  return { ok: true, targetUid, devicesRemoved, childUsersRemoved };
};

/* ════════════════════════════════ profile ═══════════════════════════════ */

/** Lightweight identity probe — provisions/refreshes the parent profile. */
export const profile: Handler = async (_env, caller, _data) => {
  const ref = db().doc(`users/${caller.uid}`);
  const snap = await ref.get();
  // Provision parents on first dashboard sign-in (replaces the lazy
  // provisioning that used to live in verifyCaller — that version also
  // captured unpaired child devices and blocked confirmPairing).
  if (caller.kind !== "device" && !snap.exists) {
    await ref.set(
      {
        role: "parent",
        plan: "free",
        createdAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  return {
    uid: caller.uid,
    role: caller.kind === "device" ? "device" : (snap.get("role") ?? "parent"),
    plan: (snap.get("plan") ?? "free") as string,
    banned: snap.get("banned") === true,
    admin: caller.token["admin"] === true,
  };
};

/* ═════════════════ realtime parent dashboard (listDevices / setPolicy) ═══ */

function tsToMs(v: unknown): number | null {
  if (v && typeof v === "object" && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

/**
 * listDevices — realtime snapshot for the parent dashboard (polled every
 * ~5s while the tab is visible). Returns ALL devices linked to this parent
 * (devices/{id}.ownerParentUid == uid) with their live sub-documents:
 * status/current (battery/network), permissions/current, policies/current,
 * backupPolicy/current — plus the terminal status of any commands the
 * dashboard is still waiting on (pendingCommands[{deviceId, commandId}]).
 * Read-only: no rate-limit pressure, single round-trip per poll.
 */
export const listDevices: Handler = async (_env, caller, data) => {
  assertAppCheck(caller);
  if (caller.kind === "device") {
    throw new ApiError("permission-denied", "Device identities cannot call parent operations.");
  }
  const uid = caller.uid;

  // Bounded pending-command lookups (dashboard re-checks these each poll).
  const pendingReq = Array.isArray(data["pendingCommands"]) ? data["pendingCommands"] : [];
  const pending = pendingReq
    .filter(
      (x): x is { deviceId: string; commandId: string } =>
        !!x && typeof x === "object" &&
        typeof (x as Record<string, unknown>)["deviceId"] === "string" &&
        typeof (x as Record<string, unknown>)["commandId"] === "string"
    )
    .map((x) => ({
      deviceId: x.deviceId.slice(0, 64),
      commandId: (x.commandId as string).slice(0, 64),
    }))
    .slice(0, 20);

  const snap = await db()
    .collection("devices")
    .where("ownerParentUid", "==", uid)
    .limit(10)
    .get();

  const devices = await Promise.all(
    snap.docs.map(async (d) => {
      const v = d.data() as Record<string, unknown>;
      const childUid = typeof v["childUid"] === "string" ? (v["childUid"] as string) : null;
      const [statusSnap, permSnap, policySnap, backupSnap, childSnap] = await Promise.all([
        d.ref.collection("status").doc("current").get(),
        d.ref.collection("permissions").doc("current").get(),
        d.ref.collection("policies").doc("current").get(),
        d.ref.collection("backupPolicy").doc("current").get(),
        childUid
          ? db().doc(`children/${childUid}`).get().catch(() => null)
          : Promise.resolve(null),
      ]);
      const status = statusSnap.exists ? (statusSnap.data() as Record<string, unknown>) : {};
      return {
        deviceId: d.id,
        deviceName: (v["deviceName"] as string) ?? "Child device",
        status: (v["status"] as string) ?? "UNKNOWN",
        banned: v["banned"] === true,
        locked: v["locked"] === true,
        childUid,
        childName:
          childSnap && childSnap.exists
            ? ((childSnap.get("displayName") as string | null) ?? null)
            : null,
        pairedAtMs: tsToMs(v["pairedAt"]),
        lastSeenAtMs: tsToMs(v["lastSeenAt"]) ?? tsToMs(status["updatedAt"]),
        batteryLevel: typeof status["batteryPercent"] === "number" ? (status["batteryPercent"] as number) : null,
        isCharging: status["charging"] === true,
        networkType: (status["networkType"] as string) ?? null,
        appVersion: (status["appVersion"] as string) ?? null,
        androidVersion: (status["androidVersion"] as string) ?? null,
        // v1.4.2 — structured device identity (child heartbeat writes these).
        model: (status["model"] as string) ?? null,
        manufacturer: (status["manufacturer"] as string) ?? null,
        ramTotalMb: typeof status["totalRamMb"] === "number" ? (status["totalRamMb"] as number) : null,
        ramAvailableMb: typeof status["availableRamMb"] === "number" ? (status["availableRamMb"] as number) : null,
        storageTotalGb: typeof status["totalStorageGb"] === "number" ? (status["totalStorageGb"] as number) : null,
        storageAvailableGb: typeof status["availableStorageGb"] === "number" ? (status["availableStorageGb"] as number) : null,
        policyVersion: (v["policyVersion"] as number | null) ?? null,
        permissions: permSnap.exists ? (permSnap.data() as Record<string, unknown>) : null,
        policy: policySnap.exists ? (policySnap.data() as Record<string, unknown>) : null,
        backupPolicy: backupSnap.exists ? (backupSnap.data() as Record<string, unknown>) : null,
      };
    })
  );

  const commands = await Promise.all(
    pending.map(async ({ deviceId, commandId }) => {
      // Parent-of-device gate: the pending id must belong to a paired device.
      const link = await db().doc(`devices/${deviceId}/parents/${uid}`).get();
      if (!link.exists) return null;
      const doc = await db().doc(`devices/${deviceId}/commands/${commandId}`).get();
      if (!doc.exists) return null;
      const v = doc.data() as Record<string, unknown>;
      return {
        commandId,
        deviceId,
        type: (v["type"] as string) ?? "UNKNOWN",
        status: (v["status"] as string) ?? "PENDING",
        result: (v["result"] as Record<string, unknown> | null) ?? null,
        completedAtMs: tsToMs(v["completedAt"]),
      };
    })
  );

  return {
    devices,
    commands: commands.filter((c): c is NonNullable<typeof c> => c !== null),
  };
};

const PKG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]{0,119}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * deviceData — heavy per-device collections the 5-second listDevices poll
 * deliberately does NOT carry (apps inventory, usage, locations, SOS,
 * backup items, notifications, active sessions). The dashboard calls this
 * on view-open + a 60s refresh while the view stays visible, keeping the
 * cheap poll cheap and Firestore read volume bounded.
 */
const DEVICE_DATA_SECTIONS = [
  "apps", "usage", "locations", "emergency", "backup", "notifications", "sessions",
] as const;
type DeviceDataSection = (typeof DEVICE_DATA_SECTIONS)[number];

export const deviceData: Handler = async (_env, caller, data) => {
  const deviceId = requireDeviceId(data["deviceId"]);
  await requireParentGate(deviceId, caller);

  const sectionReq = Array.isArray(data["sections"]) ? (data["sections"] as unknown[]) : [];
  const sections = DEVICE_DATA_SECTIONS.filter((s) =>
    sectionReq.some((x) => x === s),
  ) as DeviceDataSection[];
  if (sections.length === 0) {
    throw new ApiError(
      "invalid-argument",
      `Field "sections" must contain at least one of: ${DEVICE_DATA_SECTIONS.join(", ")}.`,
    );
  }

  const root = db().doc(`devices/${deviceId}`);
  const out: Record<string, unknown> = { deviceId };

  await Promise.all(
    sections.map(async (section) => {
      try {
        switch (section) {
          case "apps": {
            const snap = await root.collection("installedApps").limit(300).get();
            out["apps"] = snap.docs
              .filter((d) => d.id !== "_summary")
              .map((d) => {
                const v = d.data() as Record<string, unknown>;
                return {
                  packageName: d.id,
                  appName: (v["appName"] as string) ?? d.id,
                  versionName: (v["versionName"] as string) ?? "",
                  isSystem: v["isSystem"] === true,
                  installedAtMs: tsToMs(v["installedAt"]) ?? 0,
                };
              });
            break;
          }
          case "usage": {
            const since = new Date(Date.now() - 7 * 24 * 3600_000);
            const key = since.toISOString().slice(0, 10);
            const snap = await root
              .collection("appUsage")
              .where("date", ">=", key)
              .limit(8)
              .get();
            out["usage"] = snap.docs
              .map((d) => {
                const v = d.data() as Record<string, unknown>;
                return {
                  date: (v["date"] as string) ?? d.id,
                  totalScreenTimeMinutes:
                    typeof v["totalScreenTimeMinutes"] === "number"
                      ? (v["totalScreenTimeMinutes"] as number)
                      : 0,
                  perApp:
                    v["perApp"] && typeof v["perApp"] === "object"
                      ? (v["perApp"] as Record<string, { appName?: string; minutes?: number }>)
                      : {},
                };
              })
              .sort((a, b) => (a.date < b.date ? 1 : -1));
            break;
          }
          case "locations": {
            const snap = await root
              .collection("locations")
              .orderBy("timestamp", "desc")
              .limit(20)
              .get();
            out["locations"] = snap.docs.map((d) => {
              const v = d.data() as Record<string, unknown>;
              return {
                id: d.id,
                lat: typeof v["lat"] === "number" ? (v["lat"] as number) : 0,
                lng: typeof v["lng"] === "number" ? (v["lng"] as number) : 0,
                accuracy: typeof v["accuracyMeters"] === "number" ? (v["accuracyMeters"] as number) : 0,
                timestampMs: tsToMs(v["timestamp"]) ?? 0,
              };
            });
            break;
          }
          case "emergency": {
            const snap = await root
              .collection("emergencyEvents")
              .orderBy("timestamp", "desc")
              .limit(15)
              .get();
            out["emergencyEvents"] = snap.docs.map((d) => {
              const v = d.data() as Record<string, unknown>;
              const locMap =
                v["location"] && typeof v["location"] === "object"
                  ? (v["location"] as Record<string, unknown>)
                  : {};
              return {
                id: d.id,
                type: (v["type"] as string) ?? "SOS",
                lat: typeof locMap["lat"] === "number" ? (locMap["lat"] as number) : null,
                lng: typeof locMap["lng"] === "number" ? (locMap["lng"] as number) : null,
                batteryLevel:
                  typeof v["batteryPercent"] === "number" ? (v["batteryPercent"] as number) : null,
                networkType: (v["networkType"] as string) ?? null,
                acknowledged: v["acknowledged"] === true,
                createdAtMs: tsToMs(v["timestamp"]) ?? 0,
              };
            });
            break;
          }
          case "backup": {
            const [statsSnap, itemsSnap] = await Promise.all([
              root.collection("backupStats").doc("current").get(),
              root
                .collection("backupItems")
                .where("state", "==", "UPLOADED")
                .limit(30)
                .get(),
            ]);
            out["backupStats"] = statsSnap.exists
              ? (statsSnap.data() as Record<string, unknown>)
              : null;
            out["backupItems"] = itemsSnap.docs.map((d) => {
              const v = d.data() as Record<string, unknown>;
              return {
                id: d.id,
                category: (v["category"] as string) ?? "photos",
                fileName: (v["fileName"] as string) ?? d.id,
                mimeType: (v["mimeType"] as string) ?? "application/octet-stream",
                sizeBytes: typeof v["sizeBytes"] === "number" ? (v["sizeBytes"] as number) : 0,
                ivB64: (v["ivB64"] as string) ?? null,
                uploadedAtMs: tsToMs(v["uploadedAt"]) ?? tsToMs(v["createdAt"]) ?? 0,
              };
            });
            break;
          }
          case "notifications": {
            const snap = await root
              .collection("notifications")
              .orderBy("createdAt", "desc")
              .limit(15)
              .get();
            out["notifications"] = snap.docs.map((d) => {
              const v = d.data() as Record<string, unknown>;
              return {
                id: d.id,
                message: (v["message"] as string) ?? "",
                deliveredAtMs: tsToMs(v["deliveredAt"]),
                createdAtMs: tsToMs(v["createdAt"]) ?? 0,
              };
            });
            break;
          }
          case "sessions": {
            const snap = await root
              .collection("sessions")
              .where("state", "==", "ACTIVE")
              .limit(5)
              .get();
            out["sessions"] = snap.docs.map((d) => {
              const v = d.data() as Record<string, unknown>;
              return {
                sessionId: d.id,
                type: (v["type"] as string) ?? "SCREEN",
                state: (v["state"] as string) ?? "REQUESTED",
                startedAtMs: tsToMs(v["startedAt"]),
                expiresAtMs: tsToMs(v["expiresAt"]),
              };
            });
            break;
          }
        }
      } catch (err) {
        // Section failure must not sink the whole response.
        out[section] = [];
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: "deviceData_section_failed",
            deviceId,
            section,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }),
  );

  return out;
};

/**
 * setPolicy — parent writes devices/{deviceId}/policies/current (version-bumped,
 * section-merge). The child's Firestore listener applies it in realtime:
 * appBlockList/dailyLimits/bedtime (app guard + bedtime scheduler) and
 * settings.hideAppIcon / settings.protectSettings (DevicePolicyManager /
 * launcher-alias fallback). Bedtime arrives in the CHILD-NATIVE shape:
 * {start:"HH:mm", end:"HH:mm", days:[ISO 1=Mon..7=Sun], allowedPackages[]}.
 */
export const setPolicy: Handler = async (_env, caller, data) => {
  const deviceId = requireDeviceId(data["deviceId"]);
  const { uid } = (await requireParentGate(deviceId, caller)) as { uid: string };

  // Ban gates (defense in depth, mirrors dispatchCommand).
  const [deviceSnap, parentSnap] = await Promise.all([
    db().doc(`devices/${deviceId}`).get(),
    db().doc(`users/${uid}`).get(),
  ]);
  if (deviceSnap.get("banned") === true || parentSnap.get("banned") === true) {
    throw new ApiError("permission-denied", "This account or device is suspended.");
  }

  const patch = (typeof data["patch"] === "object" && data["patch"] !== null ? data["patch"] : {}) as Record<string, unknown>;

  // ---- validate allowed sections ------------------------------------------
  let blockedApps: string[] | null = null;
  if (patch["blockedApps"] !== undefined) {
    if (!Array.isArray(patch["blockedApps"]) || patch["blockedApps"].length > 300) {
      throw new ApiError("invalid-argument", 'Field "patch.blockedApps" must be an array (≤300).');
    }
    blockedApps = (patch["blockedApps"] as unknown[]).map((p) => String(p));
    if (blockedApps.some((p) => !PKG_RE.test(p))) {
      throw new ApiError("invalid-argument", "blockedApps contains an invalid package name.");
    }
  }

  let dailyLimits: Record<string, number> | null = null;
  if (patch["dailyLimits"] !== undefined) {
    const raw = patch["dailyLimits"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ApiError("invalid-argument", 'Field "patch.dailyLimits" must be an object.');
    }
    dailyLimits = {};
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 300) throw new ApiError("invalid-argument", "dailyLimits has too many entries.");
    for (const [k, v] of entries) {
      if (!PKG_RE.test(k)) throw new ApiError("invalid-argument", `Invalid package "${k.slice(0, 40)}".`);
      const m = Number(v);
      if (!Number.isFinite(m) || m < 0 || m > 1440) {
        throw new ApiError("invalid-argument", `Daily limit for "${k}" must be 0..1440 minutes.`);
      }
      dailyLimits[k] = Math.round(m);
    }
  }

  let settings: Record<string, boolean> | null = null;
  if (patch["settings"] !== undefined) {
    const raw = patch["settings"] as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ApiError("invalid-argument", 'Field "patch.settings" must be an object.');
    }
    settings = {};
    // Device-management settings are premium-gated (v1.4.0, mirrors web UI).
    if (parentSnap.get("plan") !== "premium") {
      throw new ApiError("permission-denied", "Device management requires a premium plan.");
    }
    for (const key of ["hideAppIcon", "protectSettings"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "boolean") {
          throw new ApiError("invalid-argument", `settings.${key} must be boolean.`);
        }
        settings[key] = raw[key] as boolean;
      }
    }
  }

  let bedtime: Record<string, unknown> | null | undefined;
  if (patch["bedtime"] !== undefined) {
    const raw = patch["bedtime"];
    if (raw === null) {
      bedtime = null; // explicit clear
    } else if (typeof raw === "object" && !Array.isArray(raw)) {
      const b = raw as Record<string, unknown>;
      const start = typeof b["start"] === "string" ? b["start"] : "";
      const end = typeof b["end"] === "string" ? b["end"] : "";
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
        throw new ApiError("invalid-argument", "bedtime.start/end must be HH:mm.");
      }
      const days = Array.isArray(b["days"])
        ? (b["days"] as unknown[]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 7)
        : [1, 2, 3, 4, 5, 6, 7];
      const allowedPackages = Array.isArray(b["allowedPackages"])
        ? (b["allowedPackages"] as unknown[]).map((x) => String(x)).filter((x) => PKG_RE.test(x)).slice(0, 100)
        : [];
      bedtime = { start, end, days, allowedPackages };
    } else {
      throw new ApiError("invalid-argument", 'Field "patch.bedtime" must be an object or null.');
    }
  }

  // v1.4.2 — locationTracking gate (real toggle, child gates its own writes).
  let locationTracking: boolean | null = null;
  if (patch["locationTracking"] !== undefined) {
    if (typeof patch["locationTracking"] !== "boolean") {
      throw new ApiError("invalid-argument", 'Field "patch.locationTracking" must be boolean.');
    }
    locationTracking = patch["locationTracking"] as boolean;
  }

  const ref = db().doc(`devices/${deviceId}/policies/current`);
  const version = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.exists ? snap.data() : null) as Record<string, unknown> | null;
    const nextVersion = (typeof prev?.["version"] === "number" ? (prev!["version"] as number) : 0) + 1;
    const prevSettings = (prev?.["settings"] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      version: nextVersion,
      appBlockList: blockedApps ?? prev?.["appBlockList"] ?? [],
      dailyLimits: dailyLimits ?? prev?.["dailyLimits"] ?? {},
      settings: {
        hideAppIcon: settings?.["hideAppIcon"] ?? prevSettings["hideAppIcon"] === true,
        protectSettings: settings?.["protectSettings"] ?? prevSettings["protectSettings"] === true,
      },
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    };
    if (bedtime !== undefined) {
      if (bedtime === null) next["bedtime"] = null;
      else next["bedtime"] = bedtime;
    } else if (prev?.["bedtime"] !== undefined) {
      next["bedtime"] = prev["bedtime"];
    }
    if (prev?.["emergencyContacts"] !== undefined) {
      next["emergencyContacts"] = prev["emergencyContacts"];
    }
    // locationTracking defaults to ON (true) — absent field never blocks a
    // family that paired before this feature shipped.
    next["locationTracking"] = locationTracking ?? (prev?.["locationTracking"] !== false);
    tx.set(ref, next, { merge: false });
    return nextVersion;
  });

  await writeAudit({
    functionName: "setPolicy",
    actorUid: uid,
    actorType: "PARENT",
    deviceId,
    action: "POLICY_CHANGE",
    result: "ALLOWED",
    details: { sections: Object.keys(patch), version },
  });
  return { ok: true, version };
};

/* ════════════════════════════════ unpairDevice ═══════════════════════════ */

/**
 * unpairDevice — REAL unpair (the dashboard "Remove Device" button and the
 * child Settings unpair both land here). Reverses confirmPairing in ONE
 * transaction:
 *
 *   1. devices/{id}                → status:"UNPAIRED", paired:false,
 *                                    ownerParentUid:DELETE, unpairedAt:now
 *                                    (ownerParentUid removal is the piece that
 *                                    stops listDevices from ever returning the
 *                                    device again — without it the 5s realtime
 *                                    poll re-binds the "removed" device, which
 *                                    is exactly the auto-rebind bug)
 *   2. devices/{id}/parents/{uid}  → DELETED (the ONLY requireParent trust
 *                                    artifact — must go or the parent could
 *                                    still dispatch commands to an unpaired
 *                                    device)
 *   3. children/{childUid}         → parentUid/deviceId fields DELETED
 *                                    (re-pairing re-creates them via merge)
 *
 * Caller paths:
 *   - PARENT: body.deviceId required; must own devices/{id}/parents/{uid}.
 *   - DEVICE: unpairs ITSELF (deviceId from verified claims; body ignored) —
 *     the child Settings "Unpair" uses this so the parent's dashboard stops
 *     showing the device instead of silently re-binding it every 5 s.
 */
export const unpairDevice: Handler = async (_env, caller, data) => {
  assertAppCheck(caller);

  let deviceId: string;
  if (caller.kind === "device") {
    if (!caller.deviceId) {
      throw new ApiError("permission-denied", "Device identity lacks a deviceId claim.");
    }
    deviceId = caller.deviceId;
  } else {
    deviceId = requireDeviceId(data["deviceId"]);
  }

  const deviceRef = db().doc(`devices/${deviceId}`);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new ApiError("not-found", "Device is not paired (or already removed).");
  }
  const device = deviceSnap.data() as Record<string, unknown>;

  const ownerParentUid = typeof device["ownerParentUid"] === "string" ? (device["ownerParentUid"] as string) : null;
  const childUid = typeof device["childUid"] === "string" ? (device["childUid"] as string) : null;

  // Idempotent: an already-unlinked doc (status UNPAIRED, no owner) returns
  // success instead of a misleading permission-denied on double-click.
  if (!ownerParentUid) {
    return { ok: true, deviceId, alreadyUnpaired: true };
  }

  if (caller.kind !== "device") {
    const uid = caller.uid;
    const parentLink = await deviceRef.collection("parents").doc(uid).get();
    if (!parentLink.exists) {
      throw new ApiError(
        "permission-denied",
        "You are not the parent of this device."
      );
    }
  }

  await db().runTransaction(async (tx: FsTransaction) => {
    // 1. Device doc: unlink from the parent + flag UNPAIRED (child's
    //    refreshPairedFlag probe and the new child-side listener watch this).
    tx.set(
      deviceRef,
      {
        status: "UNPAIRED",
        paired: false,
        ...(ownerParentUid ? { ownerParentUid: FieldValue.delete() } : {}),
        unpairedAt: FieldValue.serverTimestamp(),
        lastSeenAt: device["lastSeenAt"] ?? FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    // 2. Parent trust link — delete (device caller: ownerParentUid is the uid).
    if (ownerParentUid) {
      tx.delete(deviceRef.collection("parents").doc(ownerParentUid));
    }
    // 3. Child linkage cleanup (re-pairing re-creates these fields).
    if (childUid) {
      tx.set(
        db().doc(`children/${childUid}`),
        {
          parentUid: FieldValue.delete(),
          deviceId: FieldValue.delete(),
        },
        { merge: true }
      );
    }
  });

  await writeAudit({
    functionName: "unpairDevice",
    actorUid: caller.uid,
    actorType: caller.kind === "device" ? "DEVICE" : "PARENT",
    deviceId,
    action: "UNPAIR_DEVICE",
    result: "ALLOWED",
    details: {
      by: caller.kind === "device" ? "child" : "parent",
      ownerParentUid: ownerParentUid ?? null,
    },
  });

  return { ok: true, deviceId, unpaired: true };
};

/* ════════════════════════════════ sweep (cron) ═══════════════════════════ */

/**
 * Daily maintenance — Spark replacement for the four Blaze schedulers:
 *   1. expire stale PENDING commands + delete long-expired pairing codes
 *   2. close sessions stuck REQUESTED/ACTIVE past expiresAt
 *   3. retention purge (locations/notifications/sessions/commands/auditLogs)
 *   4. SOS escalation reminders to paired parents + voluntary contacts
 * Runs from the Cron trigger AND can be invoked as an admin-authorized
 * endpoint for manual sweeps.
 */
export async function runSweep(): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};

  /* ---------- 1a. expire stale PENDING commands ----------------------- */
  const now = Timestamp.now();
  let expiredCommands = 0;
  const staleCommands = await db()
    .collectionGroup("commands")
    .where("status", "==", "PENDING")
    .where("expiresAt", "<", now)
    .limit(500)
    .get();
  if (!staleCommands.empty) {
    const writer = db().bulkWriter();
    staleCommands.forEach((doc) => {
      expiredCommands++;
      writer.update(doc.ref, {
        status: "EXPIRED",
        completedAt: now,
        expiredBy: "sweep",
      });
    });
    await writer.close();
  }
  summary["expiredCommands"] = expiredCommands;

  /* ---------- 1b. delete long-expired pairing codes ------------------- */
  let deletedCodes = 0;
  const codeCutoff = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const staleCodes = await db()
    .collection("pairingCodes")
    .where("expiresAt", "<", codeCutoff)
    .limit(500)
    .get();
  if (!staleCodes.empty) {
    const writer = db().bulkWriter();
    staleCodes.forEach((doc) => {
      deletedCodes++;
      writer.delete(doc.ref);
    });
    await writer.close();
  }
  summary["deletedCodes"] = deletedCodes;

  /* ---------- 2. close stale sessions --------------------------------- */
  let sessionsExpired = 0;
  let sessionsAutoEnded = 0;
  const staleSessions = await db()
    .collectionGroup("sessions")
    .where("state", "in", ["REQUESTED", "ACTIVE"])
    .where("expiresAt", "<", now)
    .limit(500)
    .get();
  if (!staleSessions.empty) {
    const writer = db().bulkWriter();
    staleSessions.forEach((doc) => {
      const state = doc.get("state");
      if (state === "REQUESTED") {
        sessionsExpired++;
        writer.update(doc.ref, {
          state: "EXPIRED",
          endedAt: now,
          endReason: "REQUEST_TIMEOUT",
        });
      } else {
        sessionsAutoEnded++;
        writer.update(doc.ref, {
          state: "ENDED",
          endedAt: now,
          endReason: "AUTO_EXPIRED",
          "consent.revokedAt": now,
        });
      }
    });
    await writer.close();
  }
  summary["sessionsExpired"] = sessionsExpired;
  summary["sessionsAutoEnded"] = sessionsAutoEnded;

  /* ---------- 3. retention purge -------------------------------------- */
  summary["purge.locations"] = await purgeCollectionGroup("locations", "timestamp", RETENTION_DAYS.locations);
  summary["purge.notifications"] = await purgeCollectionGroup("notifications", "createdAt", RETENTION_DAYS.notifications);
  summary["purge.sessions"] = await purgeCollectionGroup("sessions", "endedAt", RETENTION_DAYS.sessions);
  summary["purge.commands"] = await purgeCollectionGroup("commands", "expiresAt", RETENTION_DAYS.commands);
  summary["purge.auditLogs"] = await purgeCollectionGroup("auditLogs", "createdAt", RETENTION_DAYS.auditLogs);

  /* ---------- 4. SOS escalation reminders ----------------------------- */
  summary["escalationReminders"] = await escalateUnacknowledgedAlerts();

  await writeAudit({
    functionName: "sweep",
    actorUid: "system",
    actorType: "SYSTEM",
    action: "SWEEP",
    result: "INFO",
    details: summary,
  });

  return summary;
}

async function purgeCollectionGroup(
  group: string,
  field: string,
  days: number
): Promise<number> {
  const cutoff = Timestamp.fromMillis(Date.now() - days * 86_400_000);
  let deleted = 0;

  for (;;) {
    const snap = await db()
      .collectionGroup(group)
      .where(field, "<", cutoff)
      .limit(300)
      .get();
    if (snap.empty) break;

    const writer = db().bulkWriter();
    snap.forEach((doc) => writer.delete(doc.ref));
    await writer.close();

    deleted += snap.size;
    if (snap.size < 300 || deleted >= RETENTION_BATCH_LIMIT) break;
  }
  return deleted;
}

/** Family SOS reminder loop — NEVER a replacement for emergency services. */
async function escalateUnacknowledgedAlerts(): Promise<number> {
  const now = Date.now();
  const openAlerts = await db()
    .collection("emergencyAlerts")
    .where("acknowledged", "==", false)
    .limit(200)
    .get();

  let reminders = 0;

  for (const alertDoc of openAlerts.docs) {
    const alert = alertDoc.data()!;
    const parentUids = Array.isArray(alert["parentUids"])
      ? (alert["parentUids"] as string[])
      : [];
    if (parentUids.length === 0) continue;

    const createdAt = alert["createdAt"] as Timestamp | undefined;
    const createdAtMs =
      createdAt && typeof createdAt.toMillis === "function" ? createdAt.toMillis() : 0;
    if (createdAtMs === 0) continue;

    const lastReminded = alert["lastRemindedAt"] as Timestamp | undefined;
    const lastRemindedMs =
      lastReminded && typeof lastReminded.toMillis === "function"
        ? lastReminded.toMillis()
        : 0;
    if (now - lastRemindedMs < REMINDER_INTERVAL_MS) continue;

    const thresholds = await Promise.all(parentUids.map(getEscalationMinutes));
    const escalationMinutes = thresholds.length
      ? Math.min(...thresholds)
      : DEFAULT_ESCALATION_MINUTES;

    if (now < createdAtMs + escalationMinutes * 60_000) continue;

    for (const parentUid of parentUids) {
      const tokens = await getFcmTokensForUser(parentUid);
      const invalid: string[] = [];
      for (const token of tokens) {
        try {
          await messaging().send({
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
          } as never);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("registration-token-not-registered")) {
            invalid.push(token);
          }
        }
      }
      await pruneFcmTokensForUser(parentUid, invalid);

      // Voluntary secondary emergency contacts (parent-entered only).
      const contacts = await db().collection(`users/${parentUid}/emergencyContacts`).get();
      for (const contactDoc of contacts.docs) {
        const contactToken = contactDoc.get("fcmToken");
        if (typeof contactToken === "string" && contactToken.length > 0) {
          try {
            await messaging().send({
              token: contactToken,
              data: {
                kind: "SOS_CONTACT_NOTICE",
                eventId: String(alert["eventId"] ?? alertDoc.id),
                deviceId: String(alert["deviceId"] ?? ""),
                parentUid,
              },
              android: { priority: "high" },
            } as never);
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
    reminders++;

    await writeAudit({
      functionName: "escalationCheck",
      actorUid: "system",
      actorType: "SYSTEM",
      action: "ESCALATION_REMINDER",
      result: "INFO",
      details: {
        eventId: alertDoc.id,
        escalationMinutes,
        notifiedParents: parentUids,
      },
    });
  }

  return reminders;
}
