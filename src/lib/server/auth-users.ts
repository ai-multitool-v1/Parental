import "server-only";
/**
 * server/auth-users.ts — REAL server-side credential store (v1.4.1).
 *
 * WHY THIS EXISTS (CRITICAL FIX #1):
 *   The previous web demo accepted ANY email + ANY password and silently
 *   auto-created accounts (registerLogin()) — no password verification at
 *   all. An attacker could log in as ANY existing user without knowing the
 *   password. This module replaces that with a genuine authentication flow:
 *
 *   - Passwords are NEVER stored in plaintext. On signup we derive a
 *     scrypt hash (N=16384, r=8, p=1, 16-byte random salt, 64-byte key) —
 *     scrypt is a memory-hard KDF in the same family as argon2/bcrypt and
 *     ships with Node (no native build deps). Login recomputes the hash and
 *     compares with timingSafeEqual.
 *   - The store persists at .server/auth-users.json (server-only dir,
 *     gitignored). Clients can NEVER read this file — only API routes do.
 *   - Brute force: 5 failed logins per email (and per IP) → 5-minute
 *     lockout, matching the admin-console pattern.
 *   - Duplicate signup rejected ("account already exists"); login with an
 *     unregistered email rejected ("no account found") — the distinct
 *     messages the product explicitly requires.
 *
 * PRODUCTION MAPPING (real Firebase deployment):
 *   signup  → Firebase Auth createUserWithEmailAndPassword + users/{uid} doc
 *   login   → Firebase Auth signInWithEmailAndPassword (+ onParentLogin
 *             blocking function: ban + rate limit) — identity source of
 *             truth becomes Firebase Auth; this file is the demo-mode
 *             equivalent with the same guarantees.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import {
  checkLockout,
  clearAttempts,
  recordFailedAttempt,
} from "./attempt-ledger";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { SERVER_STORE_DIR } from "./store-path";

/* ------------------------------- constants --------------------------------- */

const SERVER_DIR = SERVER_STORE_DIR;
const USERS_FILE = path.join(SERVER_DIR, "auth-users.json");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** 5 wrong attempts → 5 minutes locked (same pattern as the admin console). */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 5 * 60_000;

/* --------------------------------- types ----------------------------------- */

export interface AuthUserRecord {
  uid: string;
  name: string;
  email: string; // lowercased canonical
  role: "parent";
  plan: "free" | "premium";
  createdAt: number;
  lastLoginAt: number | null;
  loginCount: number;
  banned: boolean;
  banReason?: string;
  /** scrypt hash, base64 — NEVER returned to any client. */
  passwordHash: string;
  passwordSalt: string;
}

interface AuthStoreFile {
  version: 1;
  users: AuthUserRecord[];
}

/* ------------------------------ persistence -------------------------------- */

function loadStore(): AuthStoreFile {
  try {
    if (existsSync(USERS_FILE)) {
      const raw = JSON.parse(readFileSync(USERS_FILE, "utf8")) as AuthStoreFile;
      if (raw && Array.isArray(raw.users)) return raw;
    }
  } catch {
    /* corrupted file → fresh store (server-side data only) */
  }
  return { version: 1, users: [] };
}

function saveStore(store: AuthStoreFile): void {
  try {
    if (!existsSync(SERVER_DIR)) mkdirSync(SERVER_DIR, { recursive: true });
    const tmp = `${USERS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, USERS_FILE); // atomic-ish replace
  } catch (err) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "auth_store_write_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/* ------------------------------- hashing ----------------------------------- */

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return { hash: hash.toString("base64"), salt: salt.toString("base64") };
}

export function verifyPassword(
  password: string,
  hashB64: string,
  saltB64: string
): boolean {
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------------------- brute-force ledger ---------------------------- */
/* Durable, shared with /api/admin/login — see ./attempt-ledger.ts            */

export { checkLockout, clearAttempts, recordFailedAttempt };

/* -------------------------------- API --------------------------------------- */

export interface PublicUser {
  uid: string;
  name: string;
  email: string;
  role: "parent";
  plan: "free" | "premium";
  createdAt: number;
  lastLoginAt: number | null;
  loginCount: number;
  banned: boolean;
  banReason?: string;
}

/** Strips all credential material before any object leaves the server. */
export function toPublic(u: AuthUserRecord): PublicUser {
  const { passwordHash: _h, passwordSalt: _s, ...rest } = u;
  return rest;
}

function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findUserByEmail(email: string): PublicUser | null {
  const e = canonicalEmail(email);
  const found = loadStore().users.find((u) => u.email === e);
  return found ? toPublic(found) : null;
}

export class AuthError extends Error {
  constructor(
    public code:
      | "INVALID_EMAIL"
      | "WEAK_PASSWORD"
      | "PASSWORD_MISMATCH"
      | "ALREADY_EXISTS"
      | "NO_ACCOUNT"
      | "WRONG_PASSWORD"
      | "LOCKED"
      | "BANNED"
      | "MISSING_NAME",
    public detail?: string
  ) {
    super(code);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Creates a new parent account (SIGN UP). Throws AuthError. */
export function signupUser(
  name: string,
  email: string,
  password: string
): PublicUser {
  const e = canonicalEmail(email);
  if (!name || name.trim().length < 2 || name.trim().length > 64) {
    throw new AuthError("MISSING_NAME");
  }
  if (!EMAIL_RE.test(e) || e.length > 128) {
    throw new AuthError("INVALID_EMAIL");
  }
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new AuthError("WEAK_PASSWORD");
  }

  const store = loadStore();
  if (store.users.some((u) => u.email === e)) {
    throw new AuthError("ALREADY_EXISTS");
  }

  const { hash, salt } = hashPassword(password);
  const user: AuthUserRecord = {
    uid: `usr-${Date.now().toString(36)}${randomBytes(5).toString("hex")}`,
    name: name.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 64),
    email: e,
    role: "parent",
    plan: "free",
    createdAt: Date.now(),
    lastLoginAt: null,
    loginCount: 0,
    banned: false,
    passwordHash: hash,
    passwordSalt: salt,
  };
  store.users.push(user);
  saveStore(store);
  return toPublic(user);
}

/** Verifies credentials (LOG IN). Throws AuthError. Caller handles lockout. */
export function verifyLogin(
  email: string,
  password: string
): { user: PublicUser; buckets: string[] } {
  const e = canonicalEmail(email);
  if (!e || !password) throw new AuthError("WRONG_PASSWORD");

  const store = loadStore();
  const found = store.users.find((u) => u.email === e);
  // buckets: per-email + global (per-IP is added by the route layer)
  const buckets = [`email:${e}`];

  if (!found) {
    // Uniform timing: burn a hash comparison even for unknown accounts.
    hashPassword(password);
    throw new AuthError("NO_ACCOUNT");
  }
  if (!verifyPassword(password, found.passwordHash, found.passwordSalt)) {
    throw new AuthError("WRONG_PASSWORD", found.uid);
  }
  // NOTE: ban state is NOT checked here — the admin registry
  // (admin-registry.ts isEmailBanned) is the single authoritative source,
  // checked by the login route after credential verification.

  found.lastLoginAt = Date.now();
  found.loginCount += 1;
  saveStore(store);
  return { user: toPublic(found), buckets };
}

/** Buckets used by the login route for a given email. */
export function loginBuckets(email: string): string[] {
  return [`email:${canonicalEmail(email)}`];
}
