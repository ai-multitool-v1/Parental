/**
 * commands.ts — command whitelist, payload validation, creation + FCM push
 * (port of functions lib/commands.ts).
 *
 * THE WHITELIST IS THE SECURITY BOUNDARY for what a parent can make a child
 * device do. Clients cannot write devices/{id}/commands directly
 * (firestore.rules: create=false for everyone) — this module is the only
 * writer, which makes every command authenticated, validated, TTL-bound and
 * audited upstream.
 */

import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, messaging } from "./admin";
import { ApiError } from "./http";
import { PREMIUM_COMMAND_TYPES } from "./constants";

/** Single source of truth — must mirror Android CommandProcessor + website. */
export const COMMAND_WHITELIST = [
  // basic (free)
  "REQUEST_LOCATION",
  "REQUEST_STATUS",
  "SYNC_APPS",
  "SYNC_POLICY",
  "SYNC_USAGE",
  "SEND_NOTIFICATION",
  "TRIGGER_SAFETY_CHECK",
  "REQUEST_PERMISSION",
  // premium (v1.4.0 plan gate)
  "LOCK_DEVICE",
  // consent-gated live sessions (request via requestSession, stop via here)
  "REQUEST_SCREEN_SESSION",
  "REQUEST_CAMERA_SESSION",
  "REQUEST_AUDIO_SESSION",
  "STOP_SCREEN_SESSION",
  "STOP_CAMERA_SESSION",
  "STOP_AUDIO_SESSION",
] as const;

export type CommandType = (typeof COMMAND_WHITELIST)[number];

/**
 * Permission keys a parent may ASK the child to grant (REQUEST_PERMISSION).
 * The child ALWAYS shows a visible prompt — this is a request, never a grant.
 * Must mirror Android PermissionRequestActivity.handle().
 */
export const PERMISSION_REQUEST_TYPES = [
  "location",
  "notifications",
  "camera",
  "microphone",
  "appUsageAccess",
  "accessibilityService",
  "deviceAdmin",
  "batteryOptimization",
] as const;

function invalidArgument(message: string): ApiError {
  return new ApiError("invalid-argument", message);
}

/** Throws unless the requested type is whitelisted; returns the type. */
export function validateCommandType(value: unknown): CommandType {
  if (
    typeof value !== "string" ||
    !(COMMAND_WHITELIST as readonly string[]).includes(value)
  ) {
    throw invalidArgument(`Unknown command type "${String(value ?? "")}".`);
  }
  return value as CommandType;
}

/** Session request/stop commands carry exactly one UUID sessionId. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-type payload shaping. Unknown keys are rejected (strict shape), sizes
 * are capped, and types are coerced to safe primitives.
 */
export function validateCommandPayload(
  type: CommandType,
  payload: unknown
): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};

  if (type === "SEND_NOTIFICATION" && typeof payload === "string") {
    const message = payload.trim().slice(0, 500);
    if (!message) throw invalidArgument("Notification message is empty.");
    // Child CommandProcessor reads payload["title"] / payload["body"] —
    // shape the bare string into the child-native body field.
    return { body: message };
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidArgument("Payload must be an object.");
  }
  const p = payload as Record<string, unknown>;

  switch (type) {
    case "REQUEST_SCREEN_SESSION":
    case "REQUEST_CAMERA_SESSION":
    case "REQUEST_AUDIO_SESSION":
    case "STOP_SCREEN_SESSION":
    case "STOP_CAMERA_SESSION":
    case "STOP_AUDIO_SESSION": {
      const sessionId = p["sessionId"];
      if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
        throw invalidArgument('Field "payload.sessionId" must be a UUID.');
      }
      return { sessionId };
    }
    case "SEND_NOTIFICATION": {
      // Child CommandProcessor reads payload["title"] / payload["body"].
      // The web sends {message} — accept it and map to body. Unknown keys
      // stay rejected (strict shape).
      const out: Record<string, unknown> = {};
      const body = p["body"] !== undefined ? p["body"] : p["message"];
      if (body !== undefined) {
        if (typeof body !== "string") {
          throw invalidArgument('Field "payload.body" must be a string.');
        }
        out["body"] = body.trim().slice(0, 500);
      }
      const title = p["title"];
      if (title !== undefined) {
        if (typeof title !== "string") {
          throw invalidArgument('Field "payload.title" must be a string.');
        }
        out["title"] = title.trim().slice(0, 100);
      }
      if (out["body"] === undefined && out["title"] === undefined) {
        throw invalidArgument("Notification payload is empty.");
      }
      return out;
    }
    case "REQUEST_LOCATION":
    case "REQUEST_STATUS":
    case "SYNC_APPS":
    case "SYNC_POLICY":
    case "SYNC_USAGE":
    case "TRIGGER_SAFETY_CHECK":
    case "LOCK_DEVICE":
      if (Object.keys(p).length > 0) {
        throw invalidArgument(`Command "${type}" takes no payload.`);
      }
      return {};
    case "REQUEST_PERMISSION": {
      const permission = p["permission"];
      if (
        typeof permission !== "string" ||
        !(PERMISSION_REQUEST_TYPES as readonly string[]).includes(permission)
      ) {
        throw invalidArgument(
          `Field "payload.permission" must be one of: ${PERMISSION_REQUEST_TYPES.join(", ")}.`
        );
      }
      return { permission };
    }
    default: {
      // Exhaustiveness guard: a whitelist addition without a payload policy
      // must fail closed at compile time.
      const _never: never = type;
      throw invalidArgument(`No payload policy for ${String(_never)}.`);
    }
  }
}

/**
 * Hard cap for CAMERA/AUDIO session duration (consent backstop).
 * Accepts seconds; clamps to [30 s, 60 min]; invalid → 60 min.
 */
export function clampDurationMs(value: unknown): number {
  const MIN_MS = 30_000;
  const MAX_MS = 60 * 60 * 1000;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MAX_MS;
  }
  const ms = value * 1000;
  return Math.min(MAX_MS, Math.max(MIN_MS, ms));
}

export interface CreateCommandArgs {
  deviceId: string;
  createdBy: string;
  type: CommandType;
  payload: Record<string, unknown>;
}

export interface CreatedCommand {
  commandId: string;
  expiresAt: Timestamp;
  fcmSent: boolean;
}

/** TTL for a PENDING command — after this the result handler refuses it. */
const COMMAND_TTL_MS = 5 * 60 * 1000;

/**
 * Creates devices/{deviceId}/commands/{id} (PENDING, TTL-bound, single-use
 * by construction) and pushes an FCM data message to the device.
 */
export async function createAndDispatchCommand(
  args: CreateCommandArgs
): Promise<CreatedCommand> {
  const commandId = randomUUID();
  const expiresAt = Timestamp.fromMillis(Date.now() + COMMAND_TTL_MS);

  await db()
    .doc(`devices/${args.deviceId}/commands/${commandId}`)
    .set({
      commandId,
      deviceId: args.deviceId,
      type: args.type,
      payload: args.payload,
      status: "PENDING",
      createdBy: args.createdBy,
      // ⚠️ The child CommandProcessor's parent-authorization gate reads
      // data["issuedBy"] (legacy Cloud Functions shape) — a command doc with
      // only "createdBy" was REJECTED as missing_issuedBy, which auto-declined
      // EVERY parent action (apps sync, notifications, sessions, lock…).
      // Write both names; "createdBy" stays for the dashboard UI.
      issuedBy: args.createdBy,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      result: null,
      resultId: null,
      completedAt: null,
    });

  const fcmSent = await pushCommandToDevice(args.deviceId, {
    commandId,
    type: args.type,
    payload: args.payload,
    expiresAtMs: expiresAt.toMillis(),
  });

  return { commandId, expiresAt, fcmSent };
}

/** High-priority FCM data push; best-effort (device reconciles on reconnect). */
async function pushCommandToDevice(
  deviceId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  try {
    const snap = await db().doc(`devices/${deviceId}`).get();
    const token = snap.get("fcmToken");
    if (typeof token !== "string" || token.length === 0) return false;
    await messaging().send({
      token,
      data: {
        kind: "COMMAND",
        commandId: String(data["commandId"]),
        type: String(data["type"]),
        payload: JSON.stringify(data["payload"] ?? {}),
        expiresAtMs: String(data["expiresAtMs"] ?? ""),
      },
      android: { priority: "high", collapseKey: "COMMAND" },
    } as never);
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "command_fcm_failed",
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return false;
  }
}

export { PREMIUM_COMMAND_TYPES };
