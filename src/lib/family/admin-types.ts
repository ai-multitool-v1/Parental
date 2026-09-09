/**
 * Developer Admin Panel — shared types.
 *
 * Admin সিস্টেম আলাদা identity space-এ চলে (parent identity থেকে সম্পূর্ণ
 * আলাদা)। Real Firebase deployment-এ admin মানে `custom claim { admin: true }`
 * যা শুধু Admin SDK দিয়ে সেট করা যায় — client কখনো self-promote করতে পারে না।
 */

export type AdminRole = "admin" | "parent";

export interface AdminUser {
  uid: string;
  name: string;
  email: string;
  role: AdminRole;
  /** v1.4.0 — free: বেসিক ফিচার · premium: সব ফিচার (server-enforced) */
  plan: "free" | "premium";
  registeredAt: number;
  lastLoginAt: number | null;
  loginCount: number;
  banned: boolean;
  banReason?: string;
  bannedAt?: number;
  /** লাইভ সেশন আছে কি না (lastActivityAt sweep করে ম্যানেজ হয়) */
  online: boolean;
  lastActivityAt: number | null;
  sessionStartedAt: number | null;
  deviceCount: number;
}

export interface AdminDevice {
  id: string;
  name: string;
  ownerUid: string;
  ownerEmail: string;
  model: string;
  androidVersion: string;
  registeredAt: number;
  lastSeen: number;
  banned: boolean;
  banReason?: string;
  bannedAt?: number;
}

export type AdminAuditResult = "OK" | "DENIED" | "LOCKED";

export interface AdminAuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target?: string;
  result: AdminAuditResult;
  detail: string;
}

export interface AdminSession {
  username: string;
  loginAt: number;
}

/** return codes — UI আলাদা মেসেজ দেখায় */
export type AdminLoginResult = "ok" | "empty" | "invalid" | "locked";
