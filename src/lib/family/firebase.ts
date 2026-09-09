/**
 * Firebase integration layer — ব্রিজ ফাইল।
 *
 * এই প্রজেক্টের ওয়েব ড্যাশবোর্ড দুই mode-এ চলে:
 *
 * 1) DEMO mode (ডিফল্ট): কোনো Firebase credentials ছাড়াই পুরো সিস্টেম
 *    simulate করা হয় (src/lib/family/store.ts)। একই Firestore schema,
 *    একই command whitelist, একই consent flow — শুধু নেটওয়ার্ক নেই।
 *
 * 2) FIREBASE mode: নিচের env vars দিলে এই ফাইল Firebase SDK দিয়ে
 *    একই interface সার্ভ করবে:
 *      NEXT_PUBLIC_FIREBASE_API_KEY
 *      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
 *      NEXT_PUBLIC_FIREBASE_PROJECT_ID
 *      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
 *      NEXT_PUBLIC_FIREBASE_APP_ID
 *
 * Real mode-এ প্রতিটি action-এর ম্যাপিং (backend: parental-control/functions):
 *   login()            → Firebase Auth (email+MFA) + App Check
 *   generatePairingCode() → callable generatePairingCode
 *   pairDevice()       → callable confirmPairing (server-side claim সেট)
 *   dispatchCommand()  → callable dispatchCommand (whitelist+rate-limit+FCM)
 *   respondConsent()   → device-side; Firestore sessions/{id} update
 *   updatePolicy()     → callable updatePolicy (rules-এ client write বন্ধ)
 *   triggerSOS()       → Android app → emergencyEvents → onSosCreated trigger
 *   acknowledgeSOS()   → Firestore update (rules: paired parent only)
 *   setBackupCategory() → callable backupSetPolicy (v1.3.0 — rules-এ client write বন্ধ)
 *   downloadBackupItem() → callable backupGetDownloadUrl + backupGetKey (5-মিনিট presigned GET)
 *   auditLogs          → devices/{id}/auditLogs realtime listener
 *
 * ⚠️ Client-এ কখনো privileged credentials থাকবে না — সব sensitive কাজ
 * Cloud Functions-এ (admin SDK)। নিয়ম বিস্তারিত: parental-control/firebase/firestore.rules
 */
export const FIREBASE_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

export function isFirebaseConfigured(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
    return FIREBASE_ENV_KEYS.every((k) => Boolean(env[k]));
  } catch {
    return false;
  }
}

export const WEBRTC_CONFIG = {
  /** production-এ নিজস্ব TURN সার্ভার প্রয়োজন (docs/architecture.md §WebRTC) */
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
  ],
  signaling: "Firestore devices/{deviceId}/sessions/{sessionId}/signals",
} as const;
