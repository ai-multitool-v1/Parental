/**
 * constants.ts — platform-wide constants (single source of truth).
 *
 * Values here are the server-side contract that firestore.rules, the Android
 * app and the parent dashboard all rely on. Changing a TTL/limit here changes
 * it for every callable on the next deploy.
 */

/** All v2 callables + schedulers deploy to one region. */
export const REGION = "us-central1";

/* ────────────────────────────── pairing ────────────────────────────────── */

/** Code length: 8 chars × 32-symbol alphabet = 40 bits of entropy. */
export const PAIRING_CODE_LENGTH = 8;

/** 32 symbols, 0/O/1/I excluded (unambiguous when read aloud); 32 | 256 → unbiased. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Codes are deleted by cleanupExpired this long after expiry (replay buffer). */
export const PAIRING_CODE_GRACE_MS = 15 * 60 * 1000;

export const MAX_ACTIVE_PAIRING_CODES_PER_PARENT = 5;

/* ───────────────────────────── rate limits ─────────────────────────────── */

export interface RateLimitOpts {
  max: number;
  windowMs: number;
}

export const COMMAND_RATE_LIMIT: RateLimitOpts = { max: 30, windowMs: 60 * 60 * 1000 };
export const SESSION_RATE_LIMIT: RateLimitOpts = { max: 20, windowMs: 60 * 60 * 1000 };
export const NOTIFICATION_RATE_LIMIT: RateLimitOpts = { max: 60, windowMs: 60 * 60 * 1000 };
export const ADMIN_RATE_LIMIT: RateLimitOpts = { max: 30, windowMs: 60 * 60 * 1000 };
export const BACKUP_UPLOAD_RATE_LIMIT: RateLimitOpts = { max: 240, windowMs: 60 * 60 * 1000 };
export const BACKUP_DOWNLOAD_RATE_LIMIT: RateLimitOpts = { max: 60, windowMs: 60 * 60 * 1000 };
export const BACKUP_KEY_RATE_LIMIT: RateLimitOpts = { max: 30, windowMs: 60 * 60 * 1000 };

/** Auth blocking function: parent sign-ins per sliding window. */
export const LOGIN_RATE_MAX = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/* ───────────────────────────── sessions ────────────────────────────────── */

export const SESSION_TYPES = ["SCREEN", "CAMERA", "AUDIO"] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_REQUEST_TTL_MS = 15 * 60 * 1000;

/** Command types that carry a sessionId and drive the consent state machine. */
export const SESSION_COMMAND_TYPES = [
  "REQUEST_SCREEN_SESSION",
  "REQUEST_CAMERA_SESSION",
  "REQUEST_AUDIO_SESSION",
  "STOP_SCREEN_SESSION",
  "STOP_CAMERA_SESSION",
  "STOP_AUDIO_SESSION",
] as const;

/* ───────────────────────────── commands ────────────────────────────────── */

/** Live control + screen share are premium-only (v1.4.0 plan gate). */
export const PREMIUM_COMMAND_TYPES: readonly string[] = [
  "LOCK_DEVICE",
  "REQUEST_SCREEN_SESSION",
  "REQUEST_CAMERA_SESSION",
  "REQUEST_AUDIO_SESSION",
] as const;

/* ───────────────────────────── backup (v1.3.0) ─────────────────────────── */

export const BACKUP_CATEGORIES = ["photos", "videos", "contacts", "sms"] as const;

export const BACKUP_UPLOAD_URL_TTL_SECONDS = 600;
export const BACKUP_DOWNLOAD_URL_TTL_SECONDS = 300;

/* ───────────────────────────── emergency ───────────────────────────────── */

export const DEFAULT_ESCALATION_MINUTES = 5;
export const REMINDER_INTERVAL_MS = 60 * 1000;

/* ───────────────────────────── retention ───────────────────────────────── */

export const RETENTION_DAYS: Record<string, number> = {
  locations: 30,
  notifications: 90,
  sessions: 30,
  commands: 30,
  auditLogs: 365,
};
export const RETENTION_BATCH_LIMIT = 5000;

/* ─────────────────── Secret Manager / env: Cloudflare R2 ───────────────── */
/** Names of the secrets the backup callables mount (see README → R2 setup). */
export const R2_ACCOUNT_ID_PARAM = "R2_ACCOUNT_ID";
export const R2_ACCESS_KEY_ID_PARAM = "R2_ACCESS_KEY_ID";
export const R2_SECRET_ACCESS_KEY_PARAM = "R2_SECRET_ACCESS_KEY";
export const R2_BUCKET_PARAM = "R2_BUCKET_NAME";
