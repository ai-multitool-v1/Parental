"use client";
/**
 * Family Safety — মূল স্টেট স্টোর (zustand)।
 *
 * Demo mode: একটি সিমুলেটেড "চাইল্ড ডিভাইস" ও Cloud Function-এর অনুরূপ
 * authorization pipeline browser-এ চলে — যাতে pairing, command whitelist,
 * consent flow, SOS, audit log পুরোটা end-to-end দেখা যায়।
 * Real Firebase mode: এই actions গুলো Cloud Functions call করবে
 * (src/lib/family/firebase.ts দেখুন)।
 */
import { create } from "zustand";
import { toast } from "sonner";
import type {
  AuditEntry,
  BackupCategory,
  BackupItem,
  BackupStats,
  ChildDevice,
  CommandRecord,
  CommandType,
  DevicePolicy,
  FamilyState,
  PermissionKey,
  SessionRecord,
  SessionType,
} from "./types";
import { PREMIUM_COMMANDS } from "./types";
import { initialState, pairedDeviceShell } from "./seed";
import { useAdminStore } from "./admin-store";
import {
  bumpUsage,
  computeStatus,
  freshLocation,
  generatePairingCode as genCode,
  isBedtimeActive,
  uid,
} from "./engine";
import {
  callSecure,
  isRealMode,
  observeAuth,
  fetchProfile,
  realLogin,
  realSignup,
  realLogout,
  realGeneratePairingCode,
  RealApiError,
  type RealProfile,
} from "./real";

const COMMAND_TTL = 5 * 60_000;
const CONSENT_TTL = 60_000;
/**
 * Session duration caps (ms).
 * PRODUCT RULE (user request): স্ক্রিন ব্রডকাস্টে কোনো টাইমার নেই — child একবার
 * Allow করলে parent/child কেউ Stop না চাপা পর্যন্ত সেশন চলতে থাকে
 * (Infinity = কখনো auto-end হয় না)। Camera/mic-এ প্রাইভেসি ব্যাকস্টপ হিসেবে
 * শর্তসাপেক্ষ সীমা রাখা হয়েছে।
 */
const SESSION_DURATIONS: Record<SessionType, number> = {
  screen: Number.POSITIVE_INFINITY,
  camera: 120_000,
  audio: 120_000,
  safety: 240_000,
};
const RATE_MAX_PER_MIN = 12;

/** প্রতিটি backup category-র জন্য প্রয়োজনীয় Android runtime permission */
export const BACKUP_PERMISSION: Record<BackupCategory, PermissionKey> = {
  photos: "backupMediaPhotos",
  videos: "backupMediaVideos",
  contacts: "backupContacts",
  sms: "backupSms",
};

export const BACKUP_CATEGORY_LABEL: Record<BackupCategory, string> = {
  photos: "ছবি",
  videos: "ভিডিও",
  contacts: "কন্টাক্ট",
  sms: "SMS",
};

/* ------------------- auth result codes (v1.4.1, FIX #1) ------------------- */

/** login result — UI প্রতিটি কোডে আলাদা, নির্দিষ্ট মেসেজ দেখায় */
export type LoginResultCode =
  | "ok"
  | "empty"
  | "no_account"
  | "wrong_password"
  | "locked"
  | "banned"
  | "network";

/** signup result — duplicate email/weak password ইত্যাদি আলাদা করা */
export type SignupResultCode =
  | "ok"
  | "empty"
  | "bad_name"
  | "invalid_email"
  | "weak_password"
  | "mismatch"
  | "exists"
  | "network";

interface AuthApiResponse {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  user?: {
    uid: string;
    name: string;
    email: string;
    plan: "free" | "premium";
  };
}

async function postAuth(path: string, body: Record<string, unknown>): Promise<{ status: number; data: AuthApiResponse }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: AuthApiResponse;
  try {
    data = (await res.json()) as AuthApiResponse;
  } catch {
    data = { ok: false, error: "network" };
  }
  return { status: res.status, data };
}

/** uploaded items থেকে stats রি-কম্পিউট (functions-এর transaction-এর সমতুল্য demo) */
function recomputeBackupStats(items: BackupItem[]): BackupStats {
  const uploaded = items.filter((it) => it.state === "UPLOADED");
  const stats: BackupStats = { totalBytes: 0, itemCounts: {}, lastBackupAt: {} };
  for (const it of uploaded) {
    stats.totalBytes += it.sizeBytes;
    stats.itemCounts[it.category] = (stats.itemCounts[it.category] ?? 0) + 1;
    stats.lastBackupAt[it.category] = Math.max(stats.lastBackupAt[it.category] ?? 0, it.uploadedAt ?? 0);
    stats.lastBackupAtAny = Math.max(stats.lastBackupAtAny ?? 0, it.uploadedAt ?? 0);
  }
  return stats;
}

/** প্রতিটি session type-এর জন্য প্রয়োজনীয় Android permission */
export const SESSION_PERMISSION: Record<SessionType, PermissionKey[]> = {
  screen: ["screenCapture"],
  camera: ["camera"],
  audio: ["microphone"],
  safety: ["screenCapture", "camera", "microphone", "location"],
};

export const SESSION_LABEL: Record<SessionType, string> = {
  screen: "স্ক্রিন শেয়ারিং",
  camera: "ক্যামেরা সেশন",
  audio: "অডিও সেশন",
  safety: "সেফটি সেশন",
};

type Store = FamilyState & {
  /* auth — v1.4.1 SECURITY REWRITE (CRITICAL FIX #1)
   * পূর্বে: যেকোনো non-empty email+password লগইন হয়ে যেত এবং প্রথম লগইনেই
   * নতুন অ্যাকাউন্ট auto-তৈরি হতো (attacker যেকোনো existing user-এর email
   * দিয়ে ঢুকে যেতে পারত)। এখন: সার্ভার-সাইড ভেরিফিকেশন (scrypt hash +
   * persisted store + ৫-বার-ভুল → ৫-মিনিট লকআউট) — আলাদা signup/login। */
  login: (email: string, password: string) => Promise<LoginResultCode>;
  signup: (name: string, email: string, password: string, confirm: string) => Promise<SignupResultCode>;
  logout: () => void;
  toggleMfa: () => void;
  /* plan (v1.4.0) */
  /** বর্তমান parent-এর plan — admin console-এ পরিবর্তন হলে সাথে সাথে প্রযোজ্য হয় */
  isPremium: () => boolean;
  /* pairing */
  generatePairingCode: () => void;
  /** Worker কল চলাকালীন true — বাটন spinner দেখায় */
  pairingLoading: boolean;
  /** শেষ কোড-তৈরির ত্রুটি (UI-তে inline দেখানো হয়) */
  pairingError: string | null;
  pairDevice: (code: string) => boolean;
  unpairDevice: () => void;
  /* command pipeline */
  dispatchCommand: (type: CommandType, payload?: string) => void;
  /* sessions */
  respondConsent: (consentId: string, approved: boolean) => void;
  stopSession: (type: SessionType) => void;
  childStopSession: (type: SessionType) => void;
  /* notifications */
  sendNotification: (message: string) => void;
  markNotificationRead: (id: string) => void;
  /* emergency */
  triggerSOS: () => void;
  acknowledgeSOS: (id: string) => void;
  /* policy */
  updatePolicy: (patch: Partial<DevicePolicy>, detail?: string) => void;
  /* v1.3.0 — backup (backupSetPolicy callable-এর demo অনুরূপ) — premium-অনলি */
  setBackupCategory: (category: BackupCategory, enabled: boolean) => void;
  retryBackupItem: (itemId: string) => void;
  downloadBackupItem: (itemId: string) => void;
  /** স্যান্ডবক্স ডিভাইস-শেল: নতুন মিডিয়া detect → backup queue (production-এ
   *  Android MediaStore observer এটি করে; এই action শুধু demo mode panel থেকে ডাকা হয়) */
  sandboxNewMedia: (category: BackupCategory) => void;
  setAppBlocked: (packageName: string, blocked: boolean) => void;
  setDailyLimit: (packageName: string, minutes: number) => void;
  updateBedtime: (patch: Partial<DevicePolicy["bedtime"]>) => void;
  setLocationTracking: (on: boolean) => void;
  /* স্যান্ডবক্স ডিভাইস-শেল (production-এ চাইল্ড অ্যাপ এগুলো করে) */
  sandboxConsent: (consentId: string, approved: boolean) => void;
  childUnlock: () => void;
  toggleDevicePermission: (key: PermissionKey) => void;
  toggleNetwork: () => void;
  toggleCharging: () => void;
  /* system */
  tick: () => void;
  resetDemo: () => void;
  /** রিফ্রেশের পর Firebase Auth সেশন রিস্টোর (real mode) — true থাকা অবস্থায়
   *  UI loader দেখায়, লগইন স্ক্রিনে ফেলে না। */
  authChecking: boolean;
  /** অ্যাপ-মাউন্টে একবার ডাকতে হয় (page.tsx) — একবারই চলে। */
  bootstrapAuth: () => void;
};

let authBootstrapStarted = false;

let tickCount = 0;
let lowBatteryNoted = false;

const cap = <T,>(arr: T[], max: number): T[] =>
  arr.length > max ? arr.slice(0, max) : arr;

export const useFamily = create<Store>((set, get) => {
  function addAudit(a: {
    actorRole: AuditEntry["actorRole"];
    actorUid?: string;
    action: string;
    result: AuditEntry["result"];
    detail: string;
  }) {
    set((s) => ({
      auditLogs: cap(
        [
          {
            id: uid("aud"),
            actorUid: a.actorUid ?? (a.actorRole === "parent" ? s.parent?.uid ?? "parent" : "device"),
            actorRole: a.actorRole,
            action: a.action,
            timestamp: Date.now(),
            result: a.result,
            detail: a.detail,
          },
          ...s.auditLogs,
        ],
        300,
      ),
    }));
  }

  function patchDevice(patch: Partial<ChildDevice>) {
    set((s) => ({ device: { ...s.device, ...patch } }));
  }

  function patchSession(id: string, patch: Partial<SessionRecord>) {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  }

  /** ডিভাইস সাইডে command execute (Cloud Function authorization-এর অনুরূপ চেক) */
  function processCommand(commandId: string) {
    const st = get();
    const cmd = st.commands.find((c) => c.id === commandId);
    if (!cmd || cmd.status !== "pending") return; // replay/double-process guard
    // চলার পথে ডিভাইস ব্যান হলে pending command-ও ঢুকতে পারবে না
    if (useAdminStore.getState().isDeviceBanned(st.device.id)) {
      set((s) => ({
        commands: s.commands.map((c) =>
          c.id === commandId ? { ...c, status: "failed", result: "DENIED" as const, resultAt: Date.now() } : c,
        ),
      }));
      addAudit({ actorRole: "system", action: `COMMAND_${cmd.type}`, result: "DENIED", detail: "ডিভাইস ব্যানকৃত (admin policy) — execution বাতিল" });
      return;
    }
    const now = Date.now();
    if (now > cmd.expiresAt) {
      set((s) => ({
        commands: s.commands.map((c) =>
          c.id === commandId ? { ...c, status: "expired", result: "EXPIRED" as const, resultAt: now } : c,
        ),
      }));
      addAudit({ actorRole: "system", action: `COMMAND_${cmd.type}`, result: "EXPIRED", detail: "TTL 5 মিনিট অতিবাহিত" });
      return;
    }
    if (!st.device.paired || st.device.networkType === "none") return; // queued until reconnect

    set((s) => ({
      commands: s.commands.map((c) => (c.id === commandId ? { ...c, status: "executing" } : c)),
    }));
    patchDevice({ lastSeen: now });

    const fail = (result: Exclude<CommandRecord["result"], undefined>, detail: string) => {
      set((s) => ({
        commands: s.commands.map((c) =>
          c.id === commandId ? { ...c, status: "failed", result, resultAt: Date.now() } : c,
        ),
      }));
      addAudit({ actorRole: "device", action: cmd.type, result: "FAILED", detail });
      toast.error(`${cmd.type}: ${detail}`);
    };
    const succeed = (detail: string) => {
      set((s) => ({
        commands: s.commands.map((c) =>
          c.id === commandId ? { ...c, status: "executed", result: "OK" as const, resultAt: Date.now() } : c,
        ),
      }));
      addAudit({ actorRole: "device", action: cmd.type, result: "EXECUTED", detail });
    };

    const s2 = get();

    switch (cmd.type) {
      case "SYNC_POLICY": {
        patchDevice({ policy: { ...s2.device.policy } });
        succeed(`পলিসি v${s2.device.policy.version} সিংক হয়েছে`);
        break;
      }
      case "REQUEST_STATUS": {
        patchDevice({
          lastSeen: Date.now(),
          reliability: { ...s2.device.reliability, lastHeartbeat: Date.now(), serviceStatus: "active" },
        });
        succeed(`battery ${Math.round(s2.device.batteryLevel)}%, ${s2.device.networkType}`);
        break;
      }
      case "REQUEST_LOCATION": {
        if (!s2.device.permissions.location) {
          fail("PERMISSION_REQUIRED", "ACCESS_FINE_LOCATION মঞ্জুর নয়");
          break;
        }
        const loc = freshLocation(s2.locations[0]);
        set((s) => ({ locations: cap([loc, ...s.locations], 120) }));
        succeed(`লোকেশন পাঠানো হয়েছে (accuracy ±${Math.round(loc.accuracy)}m)`);
        break;
      }
      case "LOCK_DEVICE": {
        if (s2.device.managementMode === "none") {
          fail("UNSUPPORTED", "ডিভাইস ম্যানেজড নয় — DevicePolicyManager lock সম্ভব নয়");
          break;
        }
        patchDevice({ locked: true });
        succeed("DevicePolicyManager.lockNow() — ডিভাইস লক হয়েছে");
        break;
      }
      case "SEND_NOTIFICATION": {
        const ntf = {
          id: uid("ntf"),
          message: cmd.payload ?? "(খালি বার্তা)",
          sentAt: Date.now(),
          delivered: s2.device.networkType !== "none",
          deliveredAt: s2.device.networkType !== "none" ? Date.now() : undefined,
          read: false,
        };
        set((s) => ({ notifications: cap([ntf, ...s.notifications], 50) }));
        succeed(`FCM বার্তা: “${cmd.payload ?? ""}”`);
        break;
      }
      case "SYNC_APPS":
      case "SYNC_USAGE": {
        succeed(`${cmd.type === "SYNC_APPS" ? "অ্যাপ ইনভেন্টরি" : "UsageStats"} সিংক হয়েছে`);
        break;
      }
      case "REQUEST_SCREEN_SESSION":
      case "REQUEST_CAMERA_SESSION":
      case "REQUEST_AUDIO_SESSION":
      case "TRIGGER_SAFETY_CHECK": {
        const type: SessionType =
          cmd.type === "REQUEST_SCREEN_SESSION"
            ? "screen"
            : cmd.type === "REQUEST_CAMERA_SESSION"
              ? "camera"
              : cmd.type === "REQUEST_AUDIO_SESSION"
                ? "audio"
                : "safety";
        const needed = SESSION_PERMISSION[type];
        const missing = needed.filter((k) => !s2.device.permissions[k]);
        if (missing.length > 0) {
          fail(
            "PERMISSION_REQUIRED",
            `প্রয়োজনীয় permission মঞ্জুর নয়: ${missing.join(", ")} — Android consent ছাড়া এটি সম্ভব নয়`,
          );
          break;
        }
        const sessionId = uid("ses");
        const session: SessionRecord = {
          id: sessionId,
          type,
          state: "waiting_child",
          requestedBy: s2.parent?.uid ?? "parent",
          requestedAt: Date.now(),
          expiresAt: Date.now() + SESSION_DURATIONS[type],
          consent: "pending",
        };
        const consent = {
          id: uid("cns"),
          sessionId,
          type,
          requestedAt: Date.now(),
          expiresAt: Date.now() + CONSENT_TTL,
          state: "pending" as const,
        };
        set((s) => ({
          sessions: cap([session, ...s.sessions], 60),
          consentRequests: cap([consent, ...s.consentRequests], 20),
        }));
        addAudit({
          actorRole: "parent",
          action: `REQUEST_${type.toUpperCase()}_SESSION`,
          result: "PENDING",
          detail: "চাইল্ড ডিভাইসে visible consent ডায়ালগ দেখানো হচ্ছে",
        });
        set((s) => ({
          commands: s.commands.map((c) =>
            c.id === commandId ? { ...c, status: "executed", result: "OK" as const, resultAt: Date.now() } : c,
          ),
        }));
        break;
      }
      case "STOP_SCREEN_SESSION":
      case "STOP_CAMERA_SESSION":
      case "STOP_AUDIO_SESSION": {
        const type: SessionType = cmd.type.includes("SCREEN")
          ? "screen"
          : cmd.type.includes("CAMERA")
            ? "camera"
            : "audio";
        const active = s2.sessions.find((x) => x.type === type && x.state === "active");
        if (!active) {
          fail("DENIED", "কোনো সক্রিয় সেশন নেই");
          break;
        }
        patchSession(active.id, { state: "ended", endedAt: Date.now() });
        succeed("সেশন শেষ করা হয়েছে");
        break;
      }
    }
  }

  return {
    ...initialState(),

    authChecking: true,
    pairingLoading: false,
    pairingError: null,
    bootstrapAuth: () => {
      if (authBootstrapStarted) return;
      authBootstrapStarted = true;
      // DEMO mode: ডেমো অ্যাকাউন্ট সার্ভারলেস ফাইলস্টোরে থাকে (এফিমারাল) —
      // রিফ্রেশে সেশন রিস্টোর করা হয় না; সাথে সাথেই লগইন স্ক্রিন দেখাও।
      if (!isRealMode()) {
        set({ authChecking: false });
        return;
      }
      // REAL mode: Firebase Auth নিজেই সেশন পারসিস্ট করে (browserLocalPersistence)
      // — observer দিয়ে রিফ্রেশের পর UI state রিস্টোর করি।
      observeAuth((user) => {
        if (!user) {
          // সত্যিকারের লগআউট (বা টোকেন রিভোক) — UI-ও লগআউট করো।
          set({ parent: null, authChecking: false });
          return;
        }
        // লগইন/সাইনআপ action ইতিমধ্যে parent সেট করেছে — ডাবল-সেট এড়াও।
        if (get().parent?.uid === user.uid) {
          set({ authChecking: false });
          return;
        }
        // সেশন রিস্টোর: profile কলটি সার্ভারে users/{uid} লেজি-প্রোভিশনও করে।
        fetchProfile(user)
          .then((p) => {
            set({
              parent: {
                uid: p.uid,
                name: p.name,
                email: p.email,
                mfaEnabled: false,
                loginAt: Date.now(),
                plan: p.plan,
              },
              authChecking: false,
            });
          })
          .catch(() => {
            // Worker সাময়িকভাবে নাগালের বাইরে হলেও ইউজারকে লগ-আউট করা ঠিক নয় —
            // মিনিমাল প্রোফাইল নিয়ে সেশন ধরে রাখি (পরের কলে আবার চেষ্টা হবে)।
            set({
              parent: {
                uid: user.uid,
                name: user.displayName ?? (user.email ?? "").split("@")[0],
                email: user.email ?? "",
                mfaEnabled: false,
                loginAt: Date.now(),
                plan: get().parent?.plan ?? "free",
              },
              authChecking: false,
            });
          });
      });
    },

    /* ---------------- auth (v1.4.1 — server-verified) ---------------- */
    login: async (email, password) => {
      const e = email.trim();
      if (!e || !password) return "empty";
      // Developer-Admin ban pre-check (mirror) — সার্ভার এখানেই ব্লক করে
      // (onParentLogin blocking function / login route), এটি শুধু দ্রুত UX।
      if (useAdminStore.getState().isEmailBanned(e)) {
        addAudit({ actorRole: "system", action: "PARENT_LOGIN", result: "DENIED", detail: "ব্যানকৃত অ্যাকাউন্ট — লগইন প্রত্যাহৃত (admin policy)" });
        return "banned";
      }
      // REAL mode (zero-cost): Firebase Auth + Cloudflare Worker profile gate.
      if (isRealMode()) {
        const res = await realLogin(e, password);
        if (res.result !== "ok" || !res.profile) return res.result as LoginResultCode;
        const p: RealProfile = res.profile;
        set({
          parent: {
            uid: p.uid,
            name: p.name,
            email: p.email,
            mfaEnabled: false,
            loginAt: Date.now(),
            plan: p.plan,
          },
        });
        addAudit({
          actorRole: "parent",
          action: "PARENT_LOGIN",
          result: "APPROVED",
          detail: `Firebase Auth + Worker verify — ${p.plan === "premium" ? "প্রিমিয়াম" : "ফ্রি"} প্ল্যান`,
        });
        return "ok";
      }
      let status = 0;
      let data: AuthApiResponse;
      try {
        ({ status, data } = await postAuth("/api/auth/login", { email: e, password }));
      } catch {
        return "network";
      }
      if (status === 200 && data.ok && data.user) {
        const user = data.user;
        set({
          parent: {
            uid: user.uid,
            name: user.name,
            email: user.email,
            mfaEnabled: false,
            loginAt: Date.now(),
            plan: user.plan,
          },
        });
        addAudit({
          actorRole: "parent",
          action: "PARENT_LOGIN",
          result: "APPROVED",
          detail: `সার্ভার-ভেরিফাইড লগইন (scrypt) — ${user.plan === "premium" ? "প্রিমিয়াম" : "ফ্রি"} প্ল্যান`,
        });
        return "ok";
      }
      if (status === 429 || data.error === "LOCKED") {
        addAudit({ actorRole: "system", action: "PARENT_LOGIN", result: "DENIED", detail: `brute-force lockout — ৫ বার ভুল, ৫ মিনিট লক` });
        return "locked";
      }
      if (data.error === "BANNED") {
        addAudit({ actorRole: "system", action: "PARENT_LOGIN", result: "DENIED", detail: "ব্যানকৃত অ্যাকাউন্ট — সার্ভার প্রত্যাখ্যান" });
        return "banned";
      }
      if (data.error === "NO_ACCOUNT") return "no_account";
      if (data.error === "WRONG_PASSWORD") {
        addAudit({ actorRole: "system", action: "PARENT_LOGIN", result: "DENIED", detail: "ভুল পাসওয়ার্ড (সার্ভার hash মিলনি)" });
        return "wrong_password";
      }
      return "network";
    },

    signup: async (name, email, password, confirm) => {
      if (!name.trim() || !email.trim() || !password || !confirm) return "empty";
      if (password !== confirm) return "mismatch";
      // REAL mode (zero-cost): Firebase Auth account + Worker profile.
      if (isRealMode()) {
        const res = await realSignup(name, email, password);
        if (res.result !== "ok" || !res.profile) return res.result as SignupResultCode;
        const p: RealProfile = res.profile;
        set({
          parent: {
            uid: p.uid,
            name: p.name,
            email: p.email,
            mfaEnabled: false,
            loginAt: Date.now(),
            plan: p.plan,
          },
        });
        addAudit({ actorRole: "parent", action: "PARENT_SIGNUP", result: "APPROVED", detail: "Firebase Auth অ্যাকাউন্ট তৈরি হয়েছে (free plan)" });
        return "ok";
      }
      let data: AuthApiResponse;
      try {
        ({ data } = await postAuth("/api/auth/signup", { name, email, password, confirm }));
      } catch {
        return "network";
      }
      if (data.ok) return "ok";
      switch (data.error) {
        case "ALREADY_EXISTS": return "exists";
        case "WEAK_PASSWORD": return "weak_password";
        case "PASSWORD_MISMATCH": return "mismatch";
        case "INVALID_EMAIL": return "invalid_email";
        case "MISSING_NAME": return "bad_name";
        default: return "network";
      }
    },

    logout: () => {
      addAudit({ actorRole: "parent", action: "PARENT_LOGOUT", result: "EXECUTED", detail: "সেশন শেষ" });
      if (isRealMode()) void realLogout();
      set({ parent: null });
    },

    /* ---------------- plan (v1.4.0) ---------------- */
    isPremium: () => {
      const parent = get().parent;
      if (!parent) return false;
      // admin console-এ প্ল্যান বদলালে লগইন রেখেই কার্যকর হয় (single source of truth)
      const reg = useAdminStore.getState().users.find(
        (u) => u.email.toLowerCase() === parent.email.trim().toLowerCase(),
      );
      return (reg?.plan ?? parent.plan) === "premium";
    },
    toggleMfa: () => {
      const cur = get().parent;
      if (!cur) return;
      set({ parent: { ...cur, mfaEnabled: !cur.mfaEnabled } });
      addAudit({
        actorRole: "parent",
        action: cur.mfaEnabled ? "MFA_DISABLED" : "MFA_ENABLED",
        result: "EXECUTED",
        detail: cur.mfaEnabled ? "MFA বন্ধ হয়েছে" : "MFA (TOTP) চালু হয়েছে",
      });
    },

    /* ---------------- pairing ---------------- */
    generatePairingCode: () => {
      const p = get().pairing;
      if (p && !p.used && Date.now() < p.expiresAt) return; // max 1 active
      // REAL mode: the code is issued by the trusted backend (single-use,
      // 5-min TTL, server-audited) — the demo engine cannot fake it.
      // Worker এখন idempotent: active কোড থাকলে সেটাই ফেরত দেয়, নতুন কোড
      // তৈরি হয় না — তাই repeated click এ quota নষ্ট হয় না, ব্লকও হয় না।
      if (isRealMode()) {
        set({ pairingLoading: true, pairingError: null });
        const fail = (msg: string) => {
          set({ pairingLoading: false, pairingError: msg });
          addAudit({ actorRole: "parent", action: "PAIRING_CODE_CREATED", result: "DENIED", detail: msg });
          toast.error(`পেয়ারিং কোড তৈরি হয়নি: ${msg}`);
        };
        const ok = ({ code, expiresAt }: { code: string; expiresAt: number }) => {
          set({ pairing: { code, createdAt: Date.now(), expiresAt, used: false }, pairingLoading: false, pairingError: null });
          addAudit({ actorRole: "parent", action: "PAIRING_CODE_CREATED", result: "APPROVED", detail: "Worker-issued 8-অক্ষর কোড, ৫ মিনিট TTL, single-use" });
        };
        realGeneratePairingCode()
          .then(ok)
          .catch((err1: unknown) => {
            // Self-heal: প্রোফাইল প্রোভিশন মিস হয়ে থাকলে একবার profile কল করে আবার চেষ্টা
            callSecure("profile", {})
              .then(() => realGeneratePairingCode())
              .then(ok)
              .catch((err2: unknown) => {
                const e = err2 instanceof RealApiError ? err2 : err1;
                const code = e instanceof RealApiError ? e.code : "";
                let msg = e instanceof RealApiError ? e.message : "সার্ভারে পৌঁছানো যায়নি — ইন্টারনেট দেখে আবার চেষ্টা করুন";
                if (code === "resource-exhausted") msg = `অনেকবার কোড তৈরি হয়েছে — কয়েক মিনিট অপেক্ষা করে আবার চেষ্টা করুন। (${msg})`;
                if (code === "unauthenticated") msg = "সাইন-ইন শেষ হয়ে গেছে — লগআউট করে আবার সাইন ইন করুন";
                fail(msg);
              });
          });
        return;
      }
      const code = genCode();
      set({ pairing: { code, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60_000, used: false } });
      addAudit({ actorRole: "parent", action: "PAIRING_CODE_CREATED", result: "APPROVED", detail: "8-অক্ষর, ৫ মিনিট TTL, single-use (ডেমো)" });
      toast.warning("ডেমো মোড: এই কোড আসল child app-এ কাজ করবে না — এটি শুধু সিমুলেশন। Real mode চালু হলে Worker-issued কোড আসবে।");
    },
    pairDevice: (code) => {
      const p = get().pairing;
      const ok = !!p && !p.used && Date.now() < p.expiresAt && p.code === code.trim().toUpperCase();
      if (!ok) {
        addAudit({ actorRole: "device", action: "PAIR_DEVICE", result: "DENIED", detail: "ভুল/মেয়াদোত্তীর্ণ/ব্যবহৃত কোড" });
        toast.error("পেয়ারিং ব্যর্থ: কোডটি ভুল বা মেয়াদ শেষ");
        return false;
      }
      const devId = `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const shell = pairedDeviceShell(devId);
      set((s) => ({
        pairing: { ...s.pairing!, used: true },
        device: shell,
      }));
      // v1.4.1: registerDevice এখন সার্ভার POST (parent-session cookie);
      // real mode-এ confirmPairing devices/{id} ডক তৈরি করে — admin console
      // সেটিই দেখায়; sandbox-এও একই মিরর রাখা হলো।
      void useAdminStore.getState().registerDevice({
        id: devId,
        name: shell.name,
        ownerEmail: get().parent?.email ?? "—",
        model: shell.model,
      });
      addAudit({ actorRole: "device", action: "PAIR_DEVICE", result: "APPROVED", detail: "ডিভাইস ↔ অভিভাবক লিংক হয়েছে (custom claim সেট)" });
      toast.success("ডিভাইস সফলভাবে পেয়ার হয়েছে");
      return true;
    },
    unpairDevice: () => {
      set((s) => ({
        device: { ...s.device, paired: false, locked: false },
        sessions: s.sessions.map((x) => (x.state === "active" ? { ...x, state: "ended" as const, endedAt: Date.now() } : x)),
        consentRequests: s.consentRequests.map((x) => (x.state === "pending" ? { ...x, state: "expired" as const } : x)),
        pairing: null,
      }));
      addAudit({ actorRole: "parent", action: "DEVICE_UNPAIR", result: "EXECUTED", detail: "management lifecycle সঠিকভাবে শেষ হয়েছে" });
      toast.info("ডিভাইস আন-পেয়ার করা হয়েছে");
    },

    /* ---------------- command pipeline ---------------- */
    dispatchCommand: (type, payload) => {
      const st = get();
      if (!st.parent) return;
      if (!st.device.paired) {
        addAudit({ actorRole: "parent", action: type, result: "DENIED", detail: "ডিভাইস পেয়ার করা নেই" });
        toast.error("ডিভাইসটি পেয়ার করা নেই");
        return;
      }
      // v1.4.0 — Free/Premium gate: প্রিমিয়াম-অনলি command (ডিভাইস কন্ট্রোল,
      // স্ক্রিন শেয়ার, ক্যামেরা, অডিও/ভিডিও) ফ্রি ইউজার চালাতে পারে না।
      // (Real mode: dispatchCommand/requestSession callable-এ server-side চেক)
      if (PREMIUM_COMMANDS.includes(type) && !get().isPremium()) {
        addAudit({ actorRole: "system", action: type, result: "DENIED", detail: "প্রিমিয়াম প্ল্যান প্রয়োজন — ফ্রি ইউজার এই নিয়ন্ত্রণ ব্যবহার করতে পারে না" });
        toast.error("এটি একটি প্রিমিয়াম ফিচার — আপগ্রেড করুন");
        return;
      }
      // Developer Admin device-ban enforcement — ব্যানকৃত ডিভাইসে কোনো
      // command dispatch হয় না (Real mode: dispatchCommand callable চেক করে)।
      if (useAdminStore.getState().isDeviceBanned(st.device.id)) {
        addAudit({ actorRole: "system", action: type, result: "DENIED", detail: "ডিভাইস ব্যানকৃত (admin policy) — কমান্ড প্রত্যাখ্যাত" });
        toast.error("ডিভাইসটি অ্যাডমিন কর্তৃক ব্যান করা হয়েছে — কমান্ড চালানো যাচ্ছে না");
        return;
      }
      const now = Date.now();
      const recent = st.commands.filter((c) => now - c.createdAt < 60_000).length;
      if (recent >= RATE_MAX_PER_MIN) {
        addAudit({ actorRole: "system", action: type, result: "DENIED", detail: `rate limit: প্রতি মিনিটে ${RATE_MAX_PER_MIN} command` });
        toast.warning("Rate limit অতিক্রম হয়েছে — এক মিনিট অপেক্ষা করুন");
        return;
      }
      const cmd: CommandRecord = {
        id: uid("cmd"),
        type,
        createdBy: st.parent.uid,
        createdAt: now,
        expiresAt: now + COMMAND_TTL,
        status: "pending",
        payload,
      };
      set((s) => ({ commands: cap([cmd, ...s.commands], 100) }));
      addAudit({ actorRole: "parent", action: `COMMAND_${type}`, result: "PENDING", detail: payload ? payload.slice(0, 40) : "Cloud Function → FCM" });
      const delay = 1400 + Math.random() * 900;
      window.setTimeout(() => processCommand(cmd.id), delay);
    },

    /* ---------------- sessions / consent ---------------- */
    respondConsent: (consentId, approved) => {
      const st = get();
      const c = st.consentRequests.find((x) => x.id === consentId);
      if (!c || c.state !== "pending") return;
      const now = Date.now();
      if (now > c.expiresAt) {
        set((s) => ({
          consentRequests: s.consentRequests.map((x) => (x.id === consentId ? { ...x, state: "expired" as const } : x)),
        }));
        patchSession(c.sessionId, { state: "expired", consent: "declined" });
        addAudit({ actorRole: "device", action: `SESSION_CONSENT_${c.type.toUpperCase()}`, result: "EXPIRED", detail: "60 সেকেন্ডে সাড়া দেওয়া হয়নি" });
        return;
      }
      if (approved) {
        const missing = SESSION_PERMISSION[c.type].filter((k) => !st.device.permissions[k]);
        if (missing.length > 0) {
          set((s) => ({
            consentRequests: s.consentRequests.map((x) => (x.id === consentId ? { ...x, state: "declined" as const } : x)),
          }));
          patchSession(c.sessionId, { state: "expired", consent: "declined" });
          addAudit({ actorRole: "device", action: `SESSION_CONSENT_${c.type.toUpperCase()}`, result: "FAILED", detail: `permission মাঝপথে প্রত্যাহার: ${missing.join(",")}` });
          toast.error(`Permission নেই (${missing.join(", ")}) — Android এটি অনুমোদন করে না`);
          return;
        }
        set((s) => ({
          consentRequests: s.consentRequests.map((x) => (x.id === consentId ? { ...x, state: "approved" as const } : x)),
        }));
        patchSession(c.sessionId, {
          state: "active",
          consent: "approved",
          startedAt: now,
          expiresAt: now + SESSION_DURATIONS[c.type],
        });
        addAudit({
          actorRole: "child",
          action: `START_${c.type.toUpperCase()}_SESSION`,
          result: "APPROVED",
          detail:
            c.type === "screen"
              ? `চাইল্ড অনুমোদন দিয়েছে — ${SESSION_LABEL[c.type]} সক্রিয় (টাইমার নেই — Stop না চাপা পর্যন্ত চলবে)`
              : `চাইল্ড অনুমোদন দিয়েছে — ${SESSION_LABEL[c.type]} সক্রিয় (সর্বোচ্চ ${Math.round(SESSION_DURATIONS[c.type] / 60_000)} মিনিট)`,
        });
        toast.success(`${SESSION_LABEL[c.type]} সক্রিয় হয়েছে`);
      } else {
        set((s) => ({
          consentRequests: s.consentRequests.map((x) => (x.id === consentId ? { ...x, state: "declined" as const } : x)),
        }));
        patchSession(c.sessionId, { state: "declined", consent: "declined", endedAt: now });
        addAudit({ actorRole: "child", action: `START_${c.type.toUpperCase()}_SESSION`, result: "DENIED", detail: "চাইল্ড অনুমোদন দেয়নি — সেশন শুরু হয়নি" });
        toast.info("চাইল্ড ডিভাইসে অনুরোধটি declined হয়েছে");
      }
    },
    stopSession: (type) => {
      get().dispatchCommand(
        type === "screen" ? "STOP_SCREEN_SESSION" : type === "camera" ? "STOP_CAMERA_SESSION" : "STOP_AUDIO_SESSION",
      );
    },
    childStopSession: (type) => {
      const st = get();
      const active = st.sessions.find((x) => x.type === type && x.state === "active");
      if (!active) return;
      patchSession(active.id, { state: "ended", endedAt: Date.now() });
      addAudit({ actorRole: "child", action: `STOP_${type.toUpperCase()}_SESSION`, result: "EXECUTED", detail: "চাইল্ড নিজেই সেশন বন্ধ করেছে" });
      toast.info(`${SESSION_LABEL[type]} চাইল্ড কর্তৃক বন্ধ হয়েছে`);
    },

    /* ---------------- notifications ---------------- */
    sendNotification: (message) => {
      if (!message.trim()) return;
      get().dispatchCommand("SEND_NOTIFICATION", message.trim());
    },
    markNotificationRead: (id) => {
      set((s) => ({
        notifications: s.notifications.map((n) =>
          n.id === id && !n.read ? { ...n, read: true, readAt: Date.now() } : n,
        ),
      }));
    },

    /* ---------------- emergency ---------------- */
    triggerSOS: () => {
      const st = get();
      if (!st.device.paired) return;
      const last = st.emergencies.find((e) => !e.acknowledged);
      if (last && Date.now() - last.timestamp < 5 * 60_000) {
        addAudit({ actorRole: "device", action: "SOS_RATE_LIMIT", result: "DENIED", detail: "৫ মিনিটে একাধিক SOS — accidental trigger রোধ" });
        toast.warning("SOS rate limit: সাম্প্রতিক একটি SOS এখনো unacknowledged");
        return;
      }
      const loc = st.locations[0];
      const ev = {
        id: uid("sos"),
        timestamp: Date.now(),
        batteryLevel: Math.round(st.device.batteryLevel),
        networkType: st.device.networkType,
        lat: loc?.lat ?? 0,
        lng: loc?.lng ?? 0,
        acknowledged: false,
        escalationLevel: 0,
        note: "চাইল্ড ৩-সেকেন্ড কাউন্টডাউন confirm করেছে",
      };
      set((s) => ({ emergencies: cap([ev, ...s.emergencies], 50) }));
      addAudit({
        actorRole: "device",
        action: "SOS_TRIGGERED",
        result: "EXECUTED",
        detail: `battery ${ev.batteryLevel}%, ${ev.networkType}, location ${loc ? "available" : "n/a"}`,
      });
      toast.error("🚨 EMERGENCY ALERT — চাইল্ড SOS পাঠিয়েছে!", { duration: 10_000 });
    },
    acknowledgeSOS: (id) => {
      set((s) => ({
        emergencies: s.emergencies.map((e) =>
          e.id === id && !e.acknowledged ? { ...e, acknowledged: true, acknowledgedAt: Date.now() } : e,
        ),
      }));
      addAudit({ actorRole: "parent", action: "SOS_ACKNOWLEDGED", result: "EXECUTED", detail: "অভিভাবক alert দেখেছেন" });
    },

    /* ---------------- policy ---------------- */
    updatePolicy: (patch, detail) => {
      const st = get();
      if (!st.parent) return;
      // v1.4.0 — ডিভাইস ম্যানেজমেন্ট (icon hide / settings protect) প্রিমিয়াম-অনলি
      if (patch.settings && !get().isPremium()) {
        addAudit({ actorRole: "system", action: "POLICY_CHANGE", result: "DENIED", detail: "ডিভাইস ম্যানেজমেন্ট প্রিমিয়াম ফিচার" });
        toast.error("ডিভাইস ম্যানেজমেন্ট একটি প্রিমিয়াম ফিচার — আপগ্রেড করুন");
        return;
      }
      const policy: DevicePolicy = {
        ...st.device.policy,
        ...patch,
        version: st.device.policy.version + 1,
        updatedAt: Date.now(),
      };
      patchDevice({ policy });
      // Official Device Owner icon-hide demo state sync + audit.
      if (patch.settings && patch.settings.hideAppIcon !== undefined && patch.settings.hideAppIcon !== st.device.appIconHidden) {
        patchDevice({ appIconHidden: patch.settings.hideAppIcon });
        addAudit({
          actorRole: "device",
          action: "ICON_VISIBILITY_CHANGED",
          result: "EXECUTED",
          detail: patch.settings.hideAppIcon
            ? "DevicePolicyManager.setApplicationHidden(true) — আইকন লুকানো হলো; *#*#1111#*#* ডায়াল করলে আবার খুলবে"
            : "DevicePolicyManager.setApplicationHidden(false) — আইকন আবার দৃশ্যমান",
        });
      }
      addAudit({ actorRole: "parent", action: "POLICY_CHANGE", result: "EXECUTED", detail: `${detail ?? "পলিসি আপডেট"} (v${policy.version})` });
      get().dispatchCommand("SYNC_POLICY");
    },
    setAppBlocked: (packageName, blocked) => {
      const st = get();
      const blockedApps = blocked
        ? Array.from(new Set([...st.device.policy.blockedApps, packageName]))
        : st.device.policy.blockedApps.filter((p) => p !== packageName);
      const app = st.installedApps.find((a) => a.packageName === packageName);
      get().updatePolicy(
        { blockedApps },
        `${app?.appName ?? packageName} → ${blocked ? "blocked" : "allowed"}`,
      );
      addAudit({ actorRole: "parent", action: blocked ? "APP_BLOCK" : "APP_ALLOW", result: "EXECUTED", detail: app?.appName ?? packageName });
    },
    setDailyLimit: (packageName, minutes) => {
      const st = get();
      const dailyLimits = { ...st.device.policy.dailyLimits };
      if (minutes <= 0) delete dailyLimits[packageName];
      else dailyLimits[packageName] = minutes;
      const app = st.installedApps.find((a) => a.packageName === packageName);
      get().updatePolicy({ dailyLimits }, `${app?.appName ?? packageName} দৈনিক সীমা = ${minutes > 0 ? minutes + " মিনিট" : "নেই"}`);
    },
    updateBedtime: (patch) => {
      const st = get();
      get().updatePolicy(
        { bedtime: { ...st.device.policy.bedtime, ...patch } },
        `Bedtime আপডেট: ${patch.start ?? st.device.policy.bedtime.start}–${patch.end ?? st.device.policy.bedtime.end}`,
      );
    },
    setLocationTracking: (on) => {
      get().updatePolicy({ locationTracking: on }, on ? "লোকেশন ট্র্যাকিং চালু" : "লোকেশন ট্র্যাকিং বন্ধ");
    },

    /* ---------------- backup (v1.3.0, premium-অনলি v1.4.0) ---------------- */
    setBackupCategory: (category, enabled) => {
      const st = get();
      if (!st.device.paired) {
        toast.error("ডিভাইস পেয়ার করা নেই — backup policy পরিবর্তন সম্ভব নয়");
        return;
      }
      // v1.4.0 — cloud backup প্রিমিয়াম-অনলি (backupSetPolicy callable-ও চেক করে)
      if (!get().isPremium()) {
        addAudit({
          actorRole: "system",
          action: "BACKUP_POLICY_CHANGE",
          result: "DENIED",
          detail: "ক্লাউড ব্যাকআপ প্রিমিয়াম ফিচার — ফ্রি ইউজার পরিবর্তন করতে পারে না",
        });
        toast.error("ক্লাউড ব্যাকআপ একটি প্রিমিয়াম ফিচার — আপগ্রেড করুন");
        return;
      }
      if (useAdminStore.getState().isDeviceBanned(st.device.id)) {
        toast.error("ডিভাইস ব্যানকৃত (admin policy) — backup policy পরিবর্তন প্রত্যাখ্যাত");
        addAudit({
          actorRole: "system",
          action: "BACKUP_POLICY_CHANGE",
          result: "DENIED",
          detail: "ব্যানকৃত ডিভাইসে backup policy পরিবর্তন অসম্ভব (backupSetPolicy callable gate)",
        });
        return;
      }
      const version = st.backupPolicy.version + 1;
      set((s) => ({
        backupPolicy: {
          ...s.backupPolicy,
          version,
          updatedAt: Date.now(),
          updatedBy: s.parent?.uid ?? s.backupPolicy.updatedBy,
          categories: { ...s.backupPolicy.categories, [category]: { enabled } },
        },
      }));
      if (!enabled) {
        // OFF → server pre-check (backupCreateUploadUrl) সারির আইটেম বাতিল করে
        set((s) => ({
          backupItems: s.backupItems.map((it) =>
            it.category === category && (it.state === "PENDING" || it.state === "UPLOADING" || it.state === "FAILED")
              ? { ...it, state: "CANCELLED" as const, lastErrorCode: "POLICY_DISABLED" }
              : it),
        }));
      } else {
        // ON → eligible CANCELLED-by-policy items আবার resume (requirement 7)
        set((s) => ({
          backupItems: s.backupItems.map((it) =>
            it.category === category && it.state === "CANCELLED" && it.lastErrorCode === "POLICY_DISABLED"
              ? { ...it, state: "PENDING" as const, lastErrorCode: undefined }
              : it),
        }));
      }
      const label = BACKUP_CATEGORY_LABEL[category];
      addAudit({
        actorRole: "parent",
        action: "BACKUP_POLICY_CHANGE",
        result: "EXECUTED",
        detail: `${label} ${enabled ? "ON" : "OFF"} (backup policy v${version}) — ${
          enabled ? "eligible pending item resume হবে" : "queued upload server pre-check-এ CANCELLED হবে"
        }`,
      });
      toast.success(
        enabled
          ? `${label} ব্যাকআপ চালু — অপেক্ষমাণ আইটেম resume হবে`
          : `${label} ব্যাকআপ বন্ধ — সারির আইটেম আপলোডের আগে বাতিল হবে`,
      );
    },
    retryBackupItem: (itemId) => {
      const st = get();
      const item = st.backupItems.find((it) => it.id === itemId);
      if (!item || item.state !== "FAILED") return;
      if (!st.backupPolicy.categories[item.category].enabled) {
        toast.error(`${BACKUP_CATEGORY_LABEL[item.category]} ব্যাকআপ এখন OFF — আগে চালু করুন`);
        return;
      }
      set((s) => ({
        backupItems: s.backupItems.map((it) =>
          it.id === itemId ? { ...it, state: "PENDING" as const, lastErrorCode: undefined } : it),
      }));
      addAudit({
        actorRole: "parent",
        action: "BACKUP_RETRY",
        result: "PENDING",
        detail: `${item.fileName} আবার সারিতে দেওয়া হয়েছে`,
      });
      toast.info("ব্যাকআপ আবার সারিতে দেওয়া হয়েছে");
    },
    downloadBackupItem: (itemId) => {
      const st = get();
      const item = st.backupItems.find((it) => it.id === itemId);
      if (!item) return;
      if (item.state !== "UPLOADED") {
        toast.error("এই আইটেম এখনো সফলভাবে আপলোড হয়নি");
        return;
      }
      // Real mode: backupGetDownloadUrl (5-মিনিট presigned GET) + backupGetKey
      // (DEK unwrap) → browser এ WebCrypto AES-GCM decrypt। Demo: অনুরূপ
      // পাইপলাইন সিমুলেট করা হয়। R2 কখনো public হয় না।
      addAudit({
        actorRole: "parent",
        action: "BACKUP_DOWNLOAD",
        result: "EXECUTED",
        detail: `${item.fileName} — ৫ মিনিট presigned GET + AES-256-GCM decrypt (R2 private)`,
      });
      toast.success(`${item.fileName} ডিক্রিপ্ট করে ডাউনলোড করা হয়েছে (demo)`);
    },
    sandboxNewMedia: (category) => {
      const st = get();
      if (!st.device.paired) return;
      const stamp = new Date();
      const fileName =
        category === "photos" ? `IMG_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}_${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.jpg`
        : category === "videos" ? `VID_${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.mp4`
        : category === "contacts" ? `contact_${1000 + Math.floor(Math.random() * 9000)}.json`
        : `sms_${40000 + Math.floor(Math.random() * 9999)}.json`;
      const size =
        category === "photos" ? 1_500_000 + Math.floor(Math.random() * 4_000_000)
        : category === "videos" ? 40_000_000 + Math.floor(Math.random() * 160_000_000)
        : 300 + Math.floor(Math.random() * 600);
      const id = uid("bk");
      const policyOn = st.backupPolicy.categories[category].enabled;
      const permOn = st.device.permissions[BACKUP_PERMISSION[category]];
      const state: BackupItem["state"] = policyOn && permOn ? "PENDING" : "CANCELLED";
      set((s) => ({
        backupItems: [
          {
            id,
            category,
            fileName,
            mimeType: category === "photos" ? "image/jpeg" : category === "videos" ? "video/mp4" : "application/json",
            sizeBytes: size,
            checksumSha256: id.replace(/-/g, "").padEnd(64, "0"),
            state,
            attempts: 0,
            lastErrorCode: state === "CANCELLED" ? (policyOn ? "CONSENT_MISSING" : "POLICY_DISABLED") : undefined,
            createdAt: Date.now(),
          },
          ...s.backupItems,
        ],
      }));
      addAudit({
        actorRole: "device",
        action: policyOn ? "BACKUP_SCAN" : "BACKUP_UPLOAD_BLOCKED",
        result: policyOn ? "PENDING" : "DENIED",
        detail: policyOn
          ? `নতুন ${BACKUP_CATEGORY_LABEL[category]} detect → PENDING (AES-256-GCM queue)`
          : `${BACKUP_CATEGORY_LABEL[category]} backup ${policyOn ? "child consent অনুপস্থিত" : "parent policy দ্বারা বন্ধ"} — সারিতে ঢোকার আগেই বাতিল`,
      });
      if (!policyOn || !permOn) {
        toast.warning(`নতুন ${BACKUP_CATEGORY_LABEL[category]} পাওয়া গেছে, কিন্তু ব্যাকআপ অনুপস্থিত গেটের কারণে বাতিল`);
      }
    },

    /* ---------------- স্যান্ডবক্স ডিভাইস-শেল (demo-mode panel থেকে ব্যবহৃত; production-এ চাইল্ড অ্যাপ এই ভূমিকা নেয়) ---------------- */
    sandboxConsent: (consentId, approved) => {
      const st = get();
      const c = st.consentRequests.find((x) => x.id === consentId);
      if (!c || c.state !== "pending") return;
      if (approved) {
        // চাইল্ড ডিভাইসে consent dialog গ্রহণের সময় Android প্রয়োজনীয়
        // runtime permission-ও একসাথে গ্রান্ট হয় — স্যান্ডবক্সে সেটিই মিরর করা হলো।
        const missing = SESSION_PERMISSION[c.type].filter((k) => !st.device.permissions[k]);
        if (missing.length > 0) {
          patchDevice({
            permissions: {
              ...st.device.permissions,
              ...Object.fromEntries(missing.map((k) => [k, true])),
            },
          });
          addAudit({ actorRole: "device", action: "PERMISSION_STATE", result: "APPROVED", detail: `${missing.join(", ")} গ্রান্ট (consent প্রবাহে)` });
        }
      }
      get().respondConsent(consentId, approved);
    },
    childUnlock: () => {
      if (!get().device.locked) return;
      patchDevice({ locked: false });
      addAudit({ actorRole: "child", action: "DEVICE_UNLOCK", result: "EXECUTED", detail: "চাইল্ড নিজের PIN দিয়ে আনলক (Android lockNow lifecycle)" });
    },
    toggleDevicePermission: (key) => {
      const st = get();
      const next = !st.device.permissions[key];
      patchDevice({ permissions: { ...st.device.permissions, [key]: next } });
      addAudit({
        actorRole: "device",
        action: "PERMISSION_STATE",
        result: next ? "APPROVED" : "DENIED",
        detail: `${key} ${next ? "মঞ্জুর" : "প্রত্যাহার"} (Android runtime permission)`,
      });
      if (!next) {
        const active = st.sessions.find((x) => x.state === "active" && SESSION_PERMISSION[x.type].includes(key));
        if (active) {
          patchSession(active.id, { state: "ended", endedAt: Date.now() });
          addAudit({ actorRole: "system", action: "SESSION_FORCE_END", result: "EXECUTED", detail: `permission প্রত্যাহারে ${SESSION_LABEL[active.type]} বন্ধ` });
          toast.info(`Permission প্রত্যাহারে ${SESSION_LABEL[active.type]} স্বয়ংক্রিয়ভাবে বন্ধ (Android আচরণ)`);
        }
      }
    },
    toggleNetwork: () => {
      const st = get();
      const next = st.device.networkType === "none" ? "wifi" : "none";
      patchDevice({
        networkType: next,
        reliability: { ...st.device.reliability, backgroundStatus: next === "none" ? "restricted" : "running" },
      });
      if (next === "none") {
        toast.warning("চাইল্ড ডিভাইস অফলাইন — কমান্ডগুলো queue হবে (policy locally enforce হবে)");
      } else {
        toast.success("চাইল্ড ডিভাইস আবার অনলাইন — sync শুরু হবে");
      }
    },
    toggleCharging: () => {
      patchDevice({ isCharging: !get().device.isCharging });
    },

    /* ---------------- system tick ---------------- */
    tick: () => {
      tickCount += 1;
      const st = get();
      if (!st.parent) return;
      const now = Date.now();
      const online = st.device.paired && st.device.networkType !== "none";
      // admin প্যানেলের লাইভ সেশন monitor — parent activity heartbeat
      useAdminStore.getState().touchActivity(st.parent.email);

      // battery — শুধু sandbox simulation (real mode-এ আসল ব্যাটারি child app
      // থেকে আসে; এখানে fake drain/charge চালালে ভুল ডেটা ও ভুল BATTERY_LOW
      // audit তৈরি হতো)
      let battery = st.device.batteryLevel;
      if (!isRealMode()) {
        if (st.device.isCharging) battery = Math.min(100, battery + 0.4);
        else if (online) battery = Math.max(1, battery - 0.1);
        if (battery < 15 && !lowBatteryNoted) {
          lowBatteryNoted = true;
          addAudit({ actorRole: "device", action: "BATTERY_LOW", result: "EXECUTED", detail: `battery ${Math.round(battery)}% — অভিভাবক নোটিফিকেশন` });
        }
        if (battery >= 20) lowBatteryNoted = false;
      }

      // bedtime runtime state
      const bedtimeActive = isBedtimeActive(st.device.policy);

      patchDevice({
        batteryLevel: battery,
        lastSeen: online ? now : st.device.lastSeen,
        reliability: online
          ? { ...st.device.reliability, lastHeartbeat: tickCount % 3 === 0 ? now : st.device.reliability.lastHeartbeat }
          : st.device.reliability,
        bedtimeActive,
      });
      const status = computeStatus({ ...get().device });
      if (status !== get().device.status) patchDevice({ status });

      if (online) {
        // location walk
        if (get().device.policy.locationTracking && !get().device.locked) {
          const loc = freshLocation(get().locations[0]);
          if (tickCount % 3 === 0) {
            set((s) => ({
              locations: cap([{ ...loc, label: loc.label ?? undefined }, ...s.locations], 120),
            }));
          } else {
            set((s) => ({
              locations: s.locations.map((p, i) => (i === 0 ? { ...p, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy } : p)),
            }));
          }
        }
        // usage simulation
        if (!get().device.locked && Math.random() < 0.45) {
          const bp = get().device.policy.bedtime;
          if (bedtimeActive && bp.allowedApps.length > 0) {
            set((s) => ({ usage: bumpUsage(s.usage, bp.allowedApps[Math.floor(Math.random() * bp.allowedApps.length)]) }));
          } else if (!bedtimeActive) {
            set((s) => ({ usage: bumpUsage(s.usage, null) }));
          }
        }
        // v1.3.0 — backup pipeline simulation (Android UploadWorker-এর অনুরূপ):
        // PENDING → UPLOADING → UPLOADED, network-constrained, policy-gated.
        {
          const items = get().backupItems;
          const policy = get().backupPolicy;
          const uploading = items.find((it) => it.state === "UPLOADING");
          if (uploading) {
            if (Math.random() < 0.55) {
              const nowU = Date.now();
              set((s) => ({
                backupItems: s.backupItems.map((it) =>
                  it.id === uploading.id
                    ? { ...it, state: "UPLOADED" as const, uploadedAt: nowU, lastErrorCode: undefined }
                    : it),
              }));
              set((s) => ({ backupStats: recomputeBackupStats(s.backupItems) }));
              addAudit({
                actorRole: "device",
                action: "BACKUP_UPLOADED",
                result: "EXECUTED",
                detail: `${uploading.fileName} এনক্রিপ্ট করে R2-তে আপলোড সম্পন্ন (server HEAD-verified)`,
              });
            }
          } else {
            const next = items
              .filter((it) => it.state === "PENDING")
              .filter((it) => policy.categories[it.category].enabled)
              .filter((it) => get().device.permissions[BACKUP_PERMISSION[it.category]])
              .sort((a, b) => a.createdAt - b.createdAt)[0];
            if (next && Math.random() < 0.5) {
              set((s) => ({
                backupItems: s.backupItems.map((it) =>
                  it.id === next.id ? { ...it, state: "UPLOADING" as const } : it),
              }));
            }
          }
          // network-shaped FAILED retry (WorkManager backoff-এর অনুরূপ)
          const failedNet = items.find(
            (it) => it.state === "FAILED" && it.lastErrorCode === "NETWORK" && it.attempts < 3,
          );
          if (failedNet && policy.categories[failedNet.category].enabled && Math.random() < 0.2) {
            set((s) => ({
              backupItems: s.backupItems.map((it) =>
                it.id === failedNet.id ? { ...it, state: "PENDING" as const, lastErrorCode: undefined } : it),
            }));
          }
        }
        // process queued commands (পুরনো pending আগে)
        const queued = get().commands
          .filter((c) => c.status === "pending" && now - c.createdAt > 1200)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (queued[0]) processCommand(queued[0].id);
      }

      // consent expiry (60s) — উত্তর চাইল্ড ডিভাইস থেকে আসে (production);
      // স্যান্ডবক্সে devices-view-এর sandbox panel দিয়ে অনুমোদন/প্রত্যাখ্যান করা যায়।
      get().consentRequests.forEach((c) => {
        if (c.state === "pending" && now > c.expiresAt) {
          set((s) => ({
            consentRequests: s.consentRequests.map((x) => (x.id === c.id ? { ...x, state: "expired" as const } : x)),
          }));
          patchSession(c.sessionId, { state: "expired", consent: "declined" });
          addAudit({ actorRole: "device", action: `SESSION_CONSENT_${c.type.toUpperCase()}`, result: "EXPIRED", detail: "চাইল্ড সাড়া দেয়নি — সেশন মেয়াদোত্তীর্ণ" });
        }
      });

      // session auto-end (screen সেশনে expiresAt = Infinity → কখনো match হয় না)
      get().sessions.forEach((x) => {
        if (x.state === "active" && now > x.expiresAt) {
          patchSession(x.id, { state: "ended", endedAt: now });
          addAudit({ actorRole: "system", action: `SESSION_AUTO_END_${x.type.toUpperCase()}`, result: "EXECUTED", detail: "সেশনের সময়সীমা শেষ — স্বয়ংক্রিয়ভাবে শেষ" });
          toast.info(`${SESSION_LABEL[x.type]} সময়সীমা শেষে বন্ধ হয়েছে`);
        }
      });

      // command TTL expiry
      get().commands.forEach((c) => {
        if (c.status === "pending" && now > c.expiresAt) {
          set((s) => ({
            commands: s.commands.map((x) => (x.id === c.id ? { ...x, status: "expired" as const, result: "EXPIRED" as const, resultAt: now } : x)),
          }));
          addAudit({ actorRole: "system", action: `COMMAND_${c.type}`, result: "EXPIRED", detail: "TTL ৫ মিনিট — replay-সেফ মেয়াদ" });
        }
      });

      // notification delivery simulation
      get().notifications.forEach((n) => {
        if (!n.delivered && online) {
          set((s) => ({
            notifications: s.notifications.map((x) =>
              x.id === n.id ? { ...x, delivered: true, deliveredAt: Date.now() } : x,
            ),
          }));
        }
      });

      // SOS escalation (৫ মিনিট স্থির ব্যবধান — চাইল্ড/প্ল্যাটফর্ম নীতি অনুযায়ী)
      get().emergencies.forEach((e) => {
        if (e.acknowledged) return;
        const escMin = 5;
        const due = e.timestamp + (e.escalationLevel + 1) * escMin * 60_000;
        if (now >= due) {
          set((s) => ({
            emergencies: s.emergencies.map((x) => (x.id === e.id ? { ...x, escalationLevel: x.escalationLevel + 1 } : x)),
          }));
          addAudit({
            actorRole: "system",
            action: "SOS_ESCALATION",
            result: "EXECUTED",
            detail: `${escMin} মিনিটে acknowledge হয়নি — রিমাইন্ডার/escalation #${e.escalationLevel + 1}`,
          });
          toast.warning(`🚨 SOS এখনো acknowledge হয়নি — রিমাইন্ডার #${e.escalationLevel + 1} পাঠানো হয়েছে`);
        }
      });
    },

    resetDemo: () => {
      // real mode-এ এটি "লগআউট + লোকাল state রিসেট" — Firebase অ্যাকাউন্ট মুছে না
      if (isRealMode()) void realLogout();
      set({ ...initialState() });
      // v1.4.1: অ্যাডমিন রেজিস্ট্রি এখন server-side — client থেকে reset নেই
      // (নিরাপত্তা সীমানা সার্ভারে; ban/plan state ইচ্ছামতো মোছা যায় না)।
      tickCount = 0;
      lowBatteryNoted = false;
    },
  };
});
