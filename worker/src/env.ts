/**
 * env.ts — Worker bindings & runtime configuration.
 *
 * SECRETS (wrangler secret put — NEVER committed):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  full service-account JSON (Firestore/
 *     Auth/FCM/App Check Admin access). Project dashboard → Service accounts.
 *   BACKUP_KEK                     platform key-encryption-key (32 random
 *     bytes, base64) — wraps every child's backup DEK (escrow).
 *   BACKUP_URL_SECRET              HMAC secret for the short-lived R2 proxy
 *     upload/download URLs the Worker issues to devices.
 *   ADMIN_SECRET                   shared server-to-server secret for the
 *     web admin console proxy (Next.js server → Worker). Grant admin
 *     endpoints without a Firebase admin claim.
 *
 * VARS (wrangler.jsonc):
 *   ENFORCE_APP_CHECK, ALLOWED_ORIGINS, TURN_*, STUN_URLS (optional).
 */

export interface Env {
  /** Native R2 binding — private encrypted-backup bucket. */
  BACKUP_BUCKET: R2Bucket;

  FIREBASE_SERVICE_ACCOUNT_JSON: string;
  BACKUP_KEK?: string;
  BACKUP_URL_SECRET?: string;
  ADMIN_SECRET?: string;

  ENFORCE_APP_CHECK?: string;
  ALLOWED_ORIGINS?: string;

  TURN_URL?: string;
  TURN_TCP_URL?: string;
  TURN_SECRET?: string;
  STUN_URLS?: string;
}

/** Cache-first settings for R2 GET proxy responses (immutable ciphertext). */
export const R2_GET_CACHE_TTL = 300;
