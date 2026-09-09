/**
 * index.ts — Cloud Functions export barrel (Firebase v2 API, nodejs20).
 *
 * Export surface (what `firebase deploy --only functions` ships):
 *   pairing        generatePairingCode, confirmPairing
 *   commands       dispatchCommand, onCommandResult, cleanupExpired
 *   sessions       requestSession, onSessionUpdate, cleanupSessions
 *   emergency      onSosCreated, escalationCheck
 *   notifications  sendParentNotification
 *   security       onParentLogin (blocking, optional), onUserDeleted,
 *                  retentionPurge
 *   admin          adminSetBanState (v1.2.0), adminSetPlan (v1.4.0 premium)
 *
 * Nothing in this codebase exposes a client-writable privileged path:
 * every callable verifies parent/device authorization server-side, and all
 * Firestore writes from clients are constrained by firestore.rules.
 */

import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { REGION } from "./lib/constants";

// Initialize the Admin SDK once for all functions.
initializeApp();

// All functions deploy to one region (see lib/constants.ts). Per-function
// overrides (memory/timeout) are declared in each module where they differ.
setGlobalOptions({ region: REGION, maxInstances: 20 });

/* ------------------------------ pairing ------------------------------ */
export { generatePairingCode } from "./pairing/generatePairingCode";
export { confirmPairing } from "./pairing/confirmPairing";

/* ------------------------------ commands ----------------------------- */
export { dispatchCommand } from "./commands/dispatchCommand";
export { onCommandResult } from "./commands/onCommandResult";
export { cleanupExpired } from "./commands/cleanupExpired";

/* ------------------------------ sessions ----------------------------- */
export { requestSession } from "./sessions/requestSession";
export { onSessionUpdate, cleanupSessions } from "./sessions/sessionLifecycle";
export { endSession } from "./sessions/endSession";

/* ----------------------------- emergency ----------------------------- */
export { onSosCreated } from "./emergency/onSosCreated";
export { escalationCheck } from "./emergency/escalationCheck";

/* ---------------------------- notifications -------------------------- */
export { sendParentNotification } from "./notifications/sendParentNotification";

/* ------------------------------ security ----------------------------- */
export { onParentLogin } from "./security/onParentLogin";
export { onUserDeleted } from "./security/onUserDelete";
export { retentionPurge } from "./security/retentionPurge";

/* ------------------------------- backup (v1.3.0) ----------------------- */
export {
  backupSetPolicy,
  backupGetKey,
  backupCreateUploadUrl,
  backupCompleteUpload,
  backupGetDownloadUrl,
  backupListForChild,
} from "./backup/backup";

/* ------------------------------- admin (v1.2.0) ----------------------- */
export { adminSetBanState } from "./admin/adminSetBanState";
export { adminSetPlan } from "./admin/adminSetPlan";
