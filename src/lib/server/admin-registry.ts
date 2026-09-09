import "server-only";
/**
 * server/admin-registry.ts — server-side Developer-Admin state (v1.4.1).
 *
 * WHY THIS EXISTS (CRITICAL FIX #2):
 *   Previously the admin registry (users / devices / ban state / plans /
 *   audit trail) lived in client-side zustand + sessionStorage, and the
 *   admin credentials (`admin` / `setbd-admin-2025`) were hardcoded in the
 *   client bundle. Anyone with DevTools could read the password, or edit
 *   sessionStorage to forge ban state. Now:
 *
 *   - The registry persists SERVER-SIDE at .server/admin-registry.json.
 *     Clients only ever receive a sanitized projection (no credentials).
 *   - Every mutation goes through /api/admin/registry which REQUIRES a
 *     valid admin session cookie (httpOnly, signed) — see admin-auth.ts.
 *   - Ban/plan state is authoritative on the server; the client store is a
 *     read-mostly mirror for UX. Tampering with client state achieves
 *     nothing because parent-login/registry decisions are server-side.
 *
 * PRODUCTION MAPPING: Firestore collections (users/, devices/, adminAudit/)
 * + adminSetBanState / adminSetPlan callables + admin custom claim.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { AdminDevice, AdminAuditEntry, AdminAuditResult } from "@/lib/family/admin-types";
import { SERVER_STORE_DIR } from "./store-path";

const SERVER_DIR = SERVER_STORE_DIR;
const REGISTRY_FILE = path.join(SERVER_DIR, "admin-registry.json");

const AUDIT_CAP = 500;
/** এর বেশি সময় activity ছাড়া থাকলে লাইভ সেশন শেষ ধরা হয় */
export const LIVE_TIMEOUT_MS = 2 * 60_000;

/* --------------------------------- types ----------------------------------- */

export interface RegistryUser {
  uid: string;
  name: string;
  email: string;
  role: "admin" | "parent";
  plan: "free" | "premium";
  registeredAt: number;
  lastLoginAt: number | null;
  loginCount: number;
  banned: boolean;
  banReason?: string;
  bannedAt?: number;
  online: boolean;
  lastActivityAt: number | null;
  sessionStartedAt: number | null;
  deviceCount: number;
  /**
   * Auth-server mirror: true once the user signed up through /api/auth/signup
   * (which owns credentials — this registry never stores passwords).
   */
  hasCredentials?: boolean;
}

interface RegistryFile {
  version: 1;
  users: RegistryUser[];
  devices: AdminDevice[];
  audit: AdminAuditEntry[];
}

/* ------------------------------ seed (first boot) --------------------------- */

function seed(): RegistryFile {
  const now = Date.now();
  const h = 3600_000;
  const d = 24 * h;
  const rows: Array<[string, string, string, number, number, number, "free" | "premium"]> = [
    // [uid, name, email, registeredDaysAgo, lastLoginMinAgo, loginCount, plan]
    ["usr-3c8b71aa42", "করিম আহমেদ", "karim.family@gmail.com", 88, 1320, 87, "free"],
    ["usr-7d20c9e513", "রহিমা বেগুম", "rahima.begum@family.bd", 74, 240, 143, "premium"],
    ["usr-1a55f0b864", "মোঃ সাকিব হাসান", "banned@demo.family", 41, 2880, 36, "free"],
    ["usr-5e93d4c175", "সেলিম হোসেন", "selim.dev@outlook.com", 60, 720, 59, "free"],
    ["usr-8b46a2de96", "নাসরিন আক্তার", "nasrin.akter@family.bd", 52, 35, 121, "free"],
    ["usr-2f71c8ba07", "জাবির হোসেন", "jabir.hossain@gmail.com", 45, 1440, 44, "free"],
    ["usr-4d08e9fc28", "ফারহানা ইসলাম", "farhana.islam@yahoo.com", 33, 4320, 28, "free"],
    ["usr-6c19b3ad59", "তৌফিক হাসান", "toufique.hasan@gmail.com", 29, 600, 63, "premium"],
    ["usr-0e52d7be8a", "শিরিন সুলতান", "shirin.sultan@family.bd", 21, 95, 91, "free"],
    ["usr-b47a1f6c2b", "ইমরান কবির", "imran.kabir@gmail.com", 14, 15, 47, "premium"],
  ];
  return {
    version: 1,
    users: [
      // The DEVELOPER ADMIN identity lives here too (server-side auth only —
      // no password is stored here; see .server/admin-credentials.json).
      {
        uid: "adm-setbd-developer",
        name: "Developer Admin",
        email: "admin@setbd.local",
        role: "admin",
        plan: "premium",
        registeredAt: now - 120 * d,
        lastLoginAt: now - 6 * h,
        loginCount: 214,
        banned: false,
        online: false,
        lastActivityAt: null,
        sessionStartedAt: null,
        deviceCount: 0,
      },
      ...rows.map(([uid, name, email, regDays, lastLoginMin, logins, plan]) => ({
        uid,
        name,
        email,
        role: "parent" as const,
        plan,
        registeredAt: now - regDays * d,
        lastLoginAt: now - lastLoginMin * 60_000,
        loginCount: logins,
        banned: email === "banned@demo.family",
        banReason:
          email === "banned@demo.family"
            ? "প্ল্যাটফর্ম অপব্যবহার — যাচাইয়ের স্বার্থে স্থগিত"
            : undefined,
        bannedAt: email === "banned@demo.family" ? now - 12 * d : undefined,
        online: false,
        lastActivityAt: null,
        sessionStartedAt: null,
        deviceCount:
          email === "karim.family@gmail.com" ||
          email === "rahima.begum@family.bd"
            ? 1
            : 0,
      })),
    ],
    devices: [
      {
        id: "device-7f3a2b9c-4d1e-4c8a-9b2f-demo01",
        name: "রাহিমের ফোন",
        ownerUid: "usr-0e52d7be8a",
        ownerEmail: "shirin.sultan@family.bd",
        model: "Pixel 7a",
        androidVersion: "Android 14 (API 34)",
        registeredAt: now - 90 * d,
        lastSeen: now - 30_000,
        banned: false,
      },
      {
        id: "device-a1c3e5f7-9b11-4c33-8d77-abc12345678",
        name: "সাদিয়ার ট্যাব",
        ownerUid: "usr-7d20c9e513",
        ownerEmail: "rahima.begum@family.bd",
        model: "Galaxy Tab A9+",
        androidVersion: "Android 13 (API 33)",
        registeredAt: now - 70 * d,
        lastSeen: now - 12 * 60_000,
        banned: false,
      },
      {
        id: "device-b2d4f6a8-1c22-4d44-9e88-def23456789",
        name: "নিশাতের ফোন",
        ownerUid: "usr-3c8b71aa42",
        ownerEmail: "karim.family@gmail.com",
        model: "Redmi Note 12",
        androidVersion: "Android 13 (API 33)",
        registeredAt: now - 85 * d,
        lastSeen: now - 2 * d,
        banned: true,
        banReason: "একাধিক নিরাপত্তা অভিযোগ — যাচাই চলাকালীন ব্লক",
        bannedAt: now - 2 * d,
      },
      {
        id: "device-c3e5a7b9-2d33-4e55-af99-abc98765432",
        name: "আয়েশার ফোন",
        ownerUid: "usr-8b46a2de96",
        ownerEmail: "nasrin.akter@family.bd",
        model: "vivo Y21",
        androidVersion: "Android 12 (API 31)",
        registeredAt: now - 50 * d,
        lastSeen: now - 35 * 60_000,
        banned: false,
      },
    ],
    audit: [
      {
        id: "adm-1",
        at: now - 6 * h,
        actor: "admin",
        action: "ADMIN_LOGIN",
        result: "OK" as AdminAuditResult,
        detail: "কনসোল লগইন (IP মাস্কড 103.**.**.42)",
      },
      {
        id: "adm-2",
        at: now - 2 * d,
        actor: "admin",
        action: "ADMIN_BAN_DEVICE",
        target: "device-b2d4…6789",
        result: "OK" as AdminAuditResult,
        detail: "নিশাতের ফোন — একাধিক নিরাপত্তা অভিযোগ",
      },
      {
        id: "adm-3",
        at: now - 12 * d,
        actor: "admin",
        action: "ADMIN_BAN_USER",
        target: "usr-1a55f0b864",
        result: "OK" as AdminAuditResult,
        detail: "banned@demo.family — প্ল্যাটফর্ম অপব্যবহার",
      },
    ],
  };
}

/* ------------------------------ persistence -------------------------------- */

let cache: RegistryFile | null = null;

function load(): RegistryFile {
  if (cache) return cache;
  try {
    if (existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as RegistryFile;
      if (raw && Array.isArray(raw.users)) {
        cache = raw;
        return cache;
      }
    }
  } catch {
    /* fall through to seed */
  }
  cache = seed();
  save(cache);
  return cache;
}

function save(store: RegistryFile): void {
  try {
    if (!existsSync(SERVER_DIR)) mkdirSync(SERVER_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, REGISTRY_FILE);
  } catch (err) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "admin_registry_write_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/* --------------------------------- audit ------------------------------------ */

function auditId(): string {
  return `adm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function pushAudit(store: RegistryFile, entry: {
  actor?: string;
  action: string;
  target?: string;
  result: AdminAuditResult;
  detail: string;
}): void {
  store.audit = [
    {
      id: auditId(),
      at: Date.now(),
      actor: entry.actor ?? "admin",
      action: entry.action,
      target: entry.target,
      result: entry.result,
      detail: entry.detail,
    },
    ...store.audit,
  ].slice(0, AUDIT_CAP);
}

/* --------------------------------- actions ---------------------------------- */

export interface RegistrySnapshot {
  users: RegistryUser[];
  devices: AdminDevice[];
  audit: AdminAuditEntry[];
}

/** Full read — admin-cookie-guarded route only. */
export function readRegistry(): RegistrySnapshot {
  const s = load();
  return { users: s.users, devices: s.devices, audit: s.audit };
}

/** Syncs a signup from the auth store into the registry (idempotent). */
export function registerSignedUpUser(user: {
  uid: string;
  name: string;
  email: string;
}): void {
  const s = load();
  const e = user.email.trim().toLowerCase();
  if (s.users.some((u) => u.email.toLowerCase() === e)) return;
  s.users = [
    {
      uid: user.uid,
      name: user.name,
      email: user.email,
      role: "parent",
      plan: "free",
      registeredAt: Date.now(),
      lastLoginAt: null,
      loginCount: 0,
      banned: false,
      online: false,
      lastActivityAt: null,
      sessionStartedAt: null,
      deviceCount: 0,
      hasCredentials: true,
    },
    ...s.users,
  ];
  save(s);
}

/** Marks a successful parent login (server-side truth for live sessions). */
export function markParentLogin(email: string): RegistryUser | null {
  const s = load();
  const e = email.trim().toLowerCase();
  const user = s.users.find((u) => u.email.toLowerCase() === e);
  if (!user) return null;
  user.lastLoginAt = Date.now();
  user.loginCount += 1;
  user.online = true;
  user.lastActivityAt = Date.now();
  user.sessionStartedAt = Date.now();
  save(s);
  return user;
}

export function touchActivity(email: string): void {
  const s = load();
  const e = email.trim().toLowerCase();
  let changed = false;
  for (const u of s.users) {
    if (u.online && u.email.toLowerCase() === e) {
      u.lastActivityAt = Date.now();
      changed = true;
    }
  }
  if (changed) save(s);
}

export function sweepStale(): void {
  const s = load();
  const cutoff = Date.now() - LIVE_TIMEOUT_MS;
  let changed = false;
  for (const u of s.users) {
    if (u.online && (u.lastActivityAt ?? 0) < cutoff) {
      u.online = false;
      u.sessionStartedAt = null;
      changed = true;
    }
  }
  if (changed) save(s);
}

export type AdminAction =
  | { type: "banUser"; uid: string; reason: string }
  | { type: "unbanUser"; uid: string }
  | { type: "banDevice"; deviceId: string; reason: string }
  | { type: "unbanDevice"; deviceId: string }
  | { type: "forceLogout"; uid: string }
  | { type: "setPlan"; uid: string; plan: "free" | "premium" };

export interface ActionResult {
  ok: boolean;
  error?: string;
  snapshot?: RegistrySnapshot;
}

/**
 * Applies an admin mutation. Self/admin-target protection mirrored from the
 * adminSetPlan / adminSetBanState callables. Every action is audited.
 */
export function applyAdminAction(action: AdminAction, actor = "admin"): ActionResult {
  const s = load();

  switch (action.type) {
    case "banUser": {
      const user = s.users.find((u) => u.uid === action.uid);
      if (!user) return { ok: false, error: "not_found" };
      if (user.banned) return { ok: true };
      if (user.role === "admin") {
        pushAudit(s, { action: "ADMIN_BAN_USER", target: action.uid, result: "DENIED", detail: "অ্যাডমিন অ্যাকাউন্ট ব্যান করা যায় না" });
        save(s);
        return { ok: false, error: "admin_target" };
      }
      user.banned = true;
      user.banReason = action.reason || "কারণ উল্লেখ নেই";
      user.bannedAt = Date.now();
      user.online = false;
      user.lastActivityAt = null;
      user.sessionStartedAt = null;
      pushAudit(s, { action: "ADMIN_BAN_USER", target: action.uid, result: "OK", detail: `${user.email} — ${user.banReason}; লাইভ সেশন বাতিল` });
      break;
    }
    case "unbanUser": {
      const user = s.users.find((u) => u.uid === action.uid);
      if (!user || !user.banned) return { ok: true };
      user.banned = false;
      user.banReason = undefined;
      user.bannedAt = undefined;
      pushAudit(s, { action: "ADMIN_UNBAN_USER", target: action.uid, result: "OK", detail: `${user.email} পুনরায় সক্রিয়` });
      break;
    }
    case "banDevice": {
      const dev = s.devices.find((x) => x.id === action.deviceId);
      if (!dev) return { ok: false, error: "not_found" };
      if (dev.banned) return { ok: true };
      dev.banned = true;
      dev.banReason = action.reason || "কারণ উল্লেখ নেই";
      dev.bannedAt = Date.now();
      pushAudit(s, { action: "ADMIN_BAN_DEVICE", target: `${action.deviceId.slice(0, 12)}…`, result: "OK", detail: `${dev.name} — ${dev.banReason}` });
      break;
    }
    case "unbanDevice": {
      const dev = s.devices.find((x) => x.id === action.deviceId);
      if (!dev || !dev.banned) return { ok: true };
      dev.banned = false;
      dev.banReason = undefined;
      dev.bannedAt = undefined;
      pushAudit(s, { action: "ADMIN_UNBAN_DEVICE", target: `${action.deviceId.slice(0, 12)}…`, result: "OK", detail: `${dev.name} পুনরায় সক্রিয়` });
      break;
    }
    case "forceLogout": {
      const user = s.users.find((u) => u.uid === action.uid);
      if (!user || !user.online) return { ok: true };
      user.online = false;
      user.sessionStartedAt = null;
      user.lastActivityAt = null;
      pushAudit(s, { action: "ADMIN_FORCE_LOGOUT", target: action.uid, result: "OK", detail: `${user.email} লাইভ সেশন বাতিল (token revocation)` });
      break;
    }
    case "setPlan": {
      const user = s.users.find((u) => u.uid === action.uid);
      if (!user) return { ok: false, error: "not_found" };
      if (user.plan === action.plan) return { ok: true };
      if (user.role === "admin") {
        pushAudit(s, { action: "ADMIN_SET_PLAN", target: action.uid, result: "DENIED", detail: "অ্যাডমিন অ্যাকাউন্টের প্ল্যান পরিবর্তন নিষিদ্ধ" });
        save(s);
        return { ok: false, error: "admin_target" };
      }
      user.plan = action.plan;
      pushAudit(s, {
        action: "ADMIN_SET_PLAN",
        target: action.uid,
        result: "OK",
        detail: `${user.email} → ${action.plan === "premium" ? "PREMIUM (সব ফিচার)" : "FREE (বেসিক ফিচার)"}`,
      });
      break;
    }
    default:
      return { ok: false, error: "unknown_action" };
  }

  save(s);
  return { ok: true, snapshot: { users: s.users, devices: s.devices, audit: s.audit } };
}

/** Registers a paired device into the registry (mirrors confirmPairing). */
export function registerDevice(device: {
  id: string;
  name: string;
  ownerEmail: string;
  model: string;
}): void {
  const s = load();
  if (s.devices.some((x) => x.id === device.id)) return;
  s.devices = [
    {
      id: device.id,
      name: device.name,
      ownerUid: "",
      ownerEmail: device.ownerEmail,
      model: device.model,
      androidVersion: "Android",
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      banned: false,
    },
    ...s.devices,
  ];
  pushAudit(s, {
    action: "DEVICE_REGISTERED",
    target: device.id.slice(0, 12) + "…",
    result: "OK",
    detail: `${device.name} (${device.ownerEmail}) পেয়ার হয়েছে`,
  });
  save(s);
}

/** Queries used by the auth routes (server-side truth for ban state). */
export function isEmailBanned(email: string): boolean {
  const e = email.trim().toLowerCase();
  return load().users.some((u) => u.email.toLowerCase() === e && u.banned);
}

export function getUserPlanByEmail(email: string): "free" | "premium" | null {
  const e = email.trim().toLowerCase();
  const u = load().users.find((x) => x.email.toLowerCase() === e);
  return u?.plan ?? null;
}
