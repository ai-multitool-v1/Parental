"use client";
/**
 * Developer Admin Panel — client store (zustand) — v1.4.1 SECURITY REWRITE.
 *
 * ⚠️ CRITICAL FIX #2: পূর্বে এই ফাইলে admin username/password (`admin` /
 * `setbd-admin-2025`) HARDCODED ছিল — production JS bundle-এ shipped হতো,
 * DevTools দিয়ে যে কেউ বের করে admin হতে পারত। আর ব্যান/প্ল্যান রেজিস্ট্রি
 * sessionStorage-এ থাকত — client যা খুশি বদলাতে পারত।
 *
 * নতুন মডেল (server-authoritative):
 *  - ক্রেডেনশিয়াল client-এ নেই। adminLogin() শুধু POST /api/admin/login করে;
 *    ভেরিফিকেশন সার্ভারে (scrypt hash, .server/admin-credentials.json),
 *    সফল হলে httpOnly signed cookie সেট হয়।
 *  - রেজিস্ট্রি (users/devices/ban/plan/audit) সার্ভারে থাকে
 *    (.server/admin-registry.json)। এই স্টোর শুধু hydrate() করা একটা
 *    READ-MOSTLY MIRROR — প্রতিটি mutation POST /api/admin/registry দিয়ে
 *    যায়, সার্ভার যা বলে সেটাই ফাইনাল। sessionStorage persistence সম্পূর্ণ
 *    বাদ — client storage কখনো নিরাপত্তা সীমানা নয়।
 *  - Admin সেশন = httpOnly cookie (১ ঘণ্টা TTL)। Logout-এ সার্ভার cookie
 *    মুছে দেয়; client state শুধু UI-র জন্য।
 *
 * REAL FIREBASE MODE (docs/deployment.md §Admin):
 *  - Firebase Auth + `admin: true` custom claim (শুধু Admin SDK/CLI —
 *    functions/scripts/setAdminClaim.ts) + Firestore rules isAdmin() +
 *    adminSetBanState/adminSetPlan callables।
 */
import { create } from "zustand";
import { toast } from "sonner";
import type {
  AdminAuditEntry,
  AdminDevice,
  AdminLoginResult,
  AdminSession,
  AdminUser,
  FirebaseAdminUser,
} from "./admin-types";
import type { UserPlan } from "./types";

/* ------------------------- server API (single channel) ---------------------- */

interface RegistryPayload {
  ok: boolean;
  username?: string;
  users?: AdminUser[];
  devices?: AdminDevice[];
  audit?: AdminAuditEntry[];
  reason?: string;
  retryAfterMs?: number;
  error?: string;
}

async function fetchRegistry(): Promise<RegistryPayload | null> {
  try {
    const res = await fetch("/api/admin/registry", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RegistryPayload;
  } catch {
    return null;
  }
}

async function postRegistryAction(body: Record<string, unknown>): Promise<RegistryPayload | null> {
  try {
    const res = await fetch("/api/admin/registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as RegistryPayload;
  } catch {
    return null;
  }
}

function applySnapshot(
  set: (partial: Partial<AdminStore>) => void,
  data: RegistryPayload | null
): boolean {
  if (data?.ok && data.users && data.devices && data.audit) {
    set({ users: data.users, devices: data.devices, adminAudit: data.audit });
    return true;
  }
  return false;
}

/* --------------------------------- store ----------------------------------- */

interface AdminStore {
  admin: AdminSession | null;
  users: AdminUser[];
  devices: AdminDevice[];
  adminAudit: AdminAuditEntry[];
  /** registry mirror সার্ভার থেকে লোড হচ্ছে কি না */
  hydrating: boolean;
  /** server-সিঙ্ক করা lockout countdown (UX mirror — সিদ্ধান্ত সার্ভারের) */
  lockoutUntil: number | null;

  adminLogin: (username: string, password: string) => Promise<AdminLoginResult>;
  adminLogout: () => Promise<void>;
  /** /api/admin/session + /api/admin/registry — panel mount-এ ডাকা হয় */
  hydrate: () => Promise<void>;
  remainingLockoutMs: () => number;

  banUser: (uid: string, reason: string) => Promise<void>;
  unbanUser: (uid: string) => Promise<void>;
  banDevice: (deviceId: string, reason: string) => Promise<void>;
  unbanDevice: (deviceId: string) => Promise<void>;
  forceLogout: (uid: string) => Promise<void>;
  setPlan: (uid: string, plan: UserPlan) => Promise<void>;

  /** parent pairing flow — parent-session cookie-authorized server POST */
  registerDevice: (device: { id: string; name: string; ownerEmail: string; model: string }) => Promise<void>;
  /** parent heartbeat — client mirror only (server sweep hydrate-এ চলে) */
  touchActivity: (email: string) => void;

  isEmailBanned: (email: string) => boolean;
  isDeviceBanned: (deviceId: string) => boolean;
  /** stale লাইভ সেশন sweep (local mirror) */
  sweep: () => void;

  /* ---- v1.4.2 REAL Firebase accounts (Worker admin endpoints via proxy) --- */
  fbUsers: FirebaseAdminUser[];
  /** "live" = WORKER_ADMIN_SECRET কনফিগার্ড (আসল ডেটা) · "unconfigured" = setup hint */
  fbMode: "live" | "unconfigured" | "error";
  fbLoading: boolean;
  loadFirebaseUsers: () => Promise<void>;
  firebaseDeleteUser: (uid: string) => Promise<boolean>;
  firebaseSetPlan: (uid: string, plan: UserPlan) => Promise<void>;
  firebaseBanUser: (uid: string, banned: boolean, reason: string) => Promise<void>;
}

export const useAdminStore = create<AdminStore>((set, get) => {
  function patchUsers(uid: string, patch: Partial<AdminUser>) {
    set((s) => ({ users: s.users.map((u) => (u.uid === uid ? { ...u, ...patch } : u)) }));
  }
  function patchDevices(deviceId: string, patch: Partial<AdminDevice>) {
    set((s) => ({
      devices: s.devices.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)),
    }));
  }

  /** সব mutation-এর সাধারণ প্রবাহ: optimistic mirror → server POST → সার্ভার truth প্রয়োগ */
  async function mutate(body: Record<string, unknown>, successMsg?: string): Promise<void> {
    const res = await postRegistryAction(body);
    if (res === null) {
      toast.error("সার্ভারে পৌঁছানো যায়নি — অ্যাডমিন অ্যাকশন বাতিল");
      await get().hydrate();
      return;
    }
    if (!res.ok) {
      toast.error("অ্যাকশন প্রত্যাখ্যাত (সার্ভার)");
      await get().hydrate();
      return;
    }
    applySnapshot(set, res);
    if (successMsg) toast.success(successMsg);
  }

  return {
    admin: null,
    users: [],
    devices: [],
    adminAudit: [],
    hydrating: false,
    lockoutUntil: null,
    fbUsers: [],
    fbMode: "live",
    fbLoading: false,

    hydrate: async () => {
      set({ hydrating: true });
      try {
        // 1) cookie সেশন আছে কি না (httpOnly — সার্ভারই একমাত্র ভেরিফায়ার)
        let session: { username: string } | null = null;
        try {
          const res = await fetch("/api/admin/session", { cache: "no-store" });
          if (res.ok) session = (await res.json()) as { username: string };
        } catch {
          session = null;
        }
        // 2) রেজিস্ট্রি mirror (session না থাকলে 401 → null → seed দেখাবে না)
        const data = session ? await fetchRegistry() : null;
        set({
          admin: session ? { username: session.username, loginAt: Date.now() } : null,
          users: data?.users ?? [],
          devices: data?.devices ?? [],
          adminAudit: data?.audit ?? [],
        });
      } finally {
        set({ hydrating: false });
      }
    },

    adminLogin: async (username, password) => {
      if (!username.trim() || !password) return "empty";
      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = (await res.json()) as RegistryPayload;
        if (res.ok && data.ok) {
          set({
            admin: { username: String(data.username ?? username), loginAt: Date.now() },
            lockoutUntil: null,
          });
          await get().hydrate();
          return "ok";
        }
        if (res.status === 429) {
          const retry = Number(data.retryAfterMs ?? 300_000);
          set({ lockoutUntil: Date.now() + retry });
          return "locked";
        }
        return res.status === 400 ? "empty" : "invalid";
      } catch {
        return "invalid";
      }
    },

    adminLogout: async () => {
      try {
        await fetch("/api/admin/logout", { method: "POST" });
      } catch {
        /* cookie expire হবেই (TTL) */
      }
      set({ admin: null, users: [], devices: [], adminAudit: [] });
    },

    remainingLockoutMs: () => {
      const until = get().lockoutUntil;
      return until && Date.now() < until ? until - Date.now() : 0;
    },

    banUser: async (uid, reason) => {
      const user = get().users.find((x) => x.uid === uid);
      if (!user || user.banned) return;
      if (user.role === "admin") {
        toast.error("অ্যাডমিন অ্যাকাউন্ট ব্যান করা যায় না");
        return;
      }
      await mutate({ type: "banUser", uid, reason }, `${user.name} ব্যান করা হয়েছে`);
    },

    unbanUser: async (uid) => {
      const user = get().users.find((x) => x.uid === uid);
      if (!user || !user.banned) return;
      await mutate({ type: "unbanUser", uid }, `${user.name} পুনরায় সক্রিয় হয়েছে`);
    },

    banDevice: async (deviceId, reason) => {
      const dev = get().devices.find((x) => x.id === deviceId);
      if (!dev || dev.banned) return;
      await mutate(
        { type: "banDevice", deviceId, reason },
        `${dev.name} ব্যান করা হয়েছে — কমান্ড/টেলিমেট্রি ব্লক হবে`
      );
    },

    unbanDevice: async (deviceId) => {
      const dev = get().devices.find((x) => x.id === deviceId);
      if (!dev || !dev.banned) return;
      await mutate({ type: "unbanDevice", deviceId }, `${dev.name} পুনরায় সক্রিয় হয়েছে`);
    },

    forceLogout: async (uid) => {
      const user = get().users.find((x) => x.uid === uid);
      if (!user || !user.online) return;
      await mutate({ type: "forceLogout", uid }, `${user.name}-এর লাইভ সেশন বাতিল করা হয়েছে`);
      patchUsers(uid, { online: false, sessionStartedAt: null, lastActivityAt: null });
    },

    setPlan: async (uid, plan) => {
      const user = get().users.find((x) => x.uid === uid);
      if (!user || user.plan === plan) return;
      if (user.role === "admin") {
        toast.error("অ্যাডমিন অ্যাকাউন্টের প্ল্যান পরিবর্তন করা যায় না");
        return;
      }
      await mutate(
        { type: "setPlan", uid, plan },
        plan === "premium"
          ? `${user.name} এখন প্রিমিয়াম ইউজার — সব ফিচার আনলক`
          : `${user.name}-কে ফ্রি প্ল্যানে নামানো হয়েছে`
      );
    },

    registerDevice: async (device) => {
      await postRegistryAction({ type: "registerDevice", device });
      // fire-and-forget: parent flow ব্লক করবে না; real mode-এ confirmPairing
      // কর্তৃক devices/{id} তৈরি হয় — এটি শুধু কনসোল mirror।
    },

    touchActivity: (email) => {
      const e = email.trim().toLowerCase();
      set((s) => ({
        users: s.users.map((x) =>
          x.online && x.email.toLowerCase() === e ? { ...x, lastActivityAt: Date.now() } : x,
        ),
      }));
    },

    isEmailBanned: (email) => {
      const e = email.trim().toLowerCase();
      return get().users.some((x) => x.email.toLowerCase() === e && x.banned);
    },

    isDeviceBanned: (deviceId) => {
      return get().devices.some((x) => x.id === deviceId && x.banned);
    },

    sweep: () => {
      const cutoff = Date.now() - 2 * 60_000;
      set((s) => ({
        users: s.users.map((x) =>
          x.online && (x.lastActivityAt ?? 0) < cutoff
            ? { ...x, online: false, sessionStartedAt: null }
            : x,
        ),
      }));
    },

    /* ---------------- v1.4.2 REAL Firebase account management ---------------- */
    loadFirebaseUsers: async () => {
      set({ fbLoading: true });
      try {
        const res = await fetch("/api/admin/firebase-users?maxResults=500", { cache: "no-store" });
        const data = (await res.json()) as Record<string, unknown>;
        if (res.status === 503 || data["configured"] === false) {
          set({ fbMode: "unconfigured", fbUsers: [] });
          return;
        }
        if (!res.ok || data["ok"] !== true) {
          set({ fbMode: "error", fbUsers: [] });
          return;
        }
        set({
          fbMode: "live",
          fbUsers: (data["users"] ?? []) as unknown as FirebaseAdminUser[],
        });
      } catch {
        set({ fbMode: "error", fbUsers: [] });
      } finally {
        set({ fbLoading: false });
      }
    },

    firebaseDeleteUser: async (uid) => {
      try {
        const res = await fetch("/api/admin/firebase-users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete", uid }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (res.ok && data["ok"] === true) {
          toast.success(
            `অ্যাকাউন্ট ডিলিট হয়েছে (${String(data["devicesRemoved"] ?? 0)} ডিভাইস, ${String(data["childUsersRemoved"] ?? 0)} চাইল্ড অ্যাকাউন্ট সহ)`,
          );
          await get().loadFirebaseUsers();
          return true;
        }
        toast.error(`ডিলিট ব্যর্থ (${res.status}) — সার্ভার লগ দেখুন`);
        return false;
      } catch {
        toast.error("সার্ভারে পৌঁছানো যায়নি");
        return false;
      }
    },

    firebaseSetPlan: async (uid, plan) => {
      const user = get().fbUsers.find((x) => x.uid === uid);
      try {
        const res = await fetch("/api/admin/firebase-users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "plan", uid, plan }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (res.ok && data["ok"] === true) {
          toast.success(
            plan === "premium"
              ? `${user?.email ?? uid} এখন প্রিমিয়াম — সব ফিচার আনলক`
              : `${user?.email ?? uid}-কে ফ্রি প্ল্যানে নামানো হয়েছে`,
          );
          set((s) => ({
            fbUsers: s.fbUsers.map((x) => (x.uid === uid ? { ...x, plan } : x)),
          }));
        } else {
          toast.error(`প্ল্যান পরিবর্তন ব্যর্থ (${res.status})`);
        }
      } catch {
        toast.error("সার্ভারে পৌঁছানো যায়নি");
      }
    },

    firebaseBanUser: async (uid, banned, reason) => {
      const user = get().fbUsers.find((x) => x.uid === uid);
      try {
        const res = await fetch("/api/admin/firebase-users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "ban", uid, banned, reason }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (res.ok && data["ok"] === true) {
          toast.success(banned ? `${user?.email ?? uid} ব্যান করা হয়েছে` : `${user?.email ?? uid} পুনরায় সক্রিয়`);
          set((s) => ({
            fbUsers: s.fbUsers.map((x) => (x.uid === uid ? { ...x, banned } : x)),
          }));
        } else {
          toast.error(`অ্যাকশন ব্যর্থ (${res.status})`);
        }
      } catch {
        toast.error("সার্ভারে পৌঁছানো যায়নি");
      }
    },
  };
});
