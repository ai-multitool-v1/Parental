import "server-only";
/**
 * server/admin-auth.ts — server-side admin authentication (v1.4.1).
 *
 * WHY THIS EXISTS (CRITICAL FIX #2):
 *   The admin username/password used to be hardcoded in client code
 *   (admin-store.ts: `admin` / `setbd-admin-2025`) — shipped in the JS
 *   bundle, trivially extractable from DevTools. Now:
 *
 *   - Credentials live ONLY on the server (.server/admin-credentials.json,
 *     mode 0600, gitignored) as a scrypt hash + salt. NEVER in the client
 *     bundle. The plaintext bootstrap password is printed ONCE to the
 *     server console on first boot; the operator can also set
 *     ADMIN_PASSWORD_HASH (scrypt$N$r$p$salt$hash, base64 pieces) via env.
 *   - Verification happens exclusively inside POST /api/admin/login
 *     (server route). The client never sees, compares or stores a secret.
 *   - Success issues an httpOnly + sameSite cookie holding an HMAC-signed
 *     token (secret at .server/session-secret.json, 0600). The cookie is
 *     the ONLY thing client code can read, and it grants nothing outside
 *     the /api/admin routes.
 *   - 5 wrong attempts → 5-minute lockout (server-side, same pattern as
 *     the parent login + admin console convention).
 *
 * PRODUCTION MAPPING (real Firebase deployment):
 *   Admin identity = Firebase Auth account with `admin: true` custom claim
 *   (set ONLY via Admin SDK/CLI — see parental-control/functions/scripts/
 *   setAdminClaim.ts). Login = Firebase Auth sign-in; authorization =
 *   verified claim inside each callable + Firestore rules isAdmin(). This
 *   file is the demo-mode equivalent with the same trust boundary: the
 *   browser never holds a privileged secret.
 */

import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  checkLockout,
  clearAttempts,
  recordFailedAttempt,
} from "./attempt-ledger";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { SERVER_STORE_DIR } from "./store-path";

const SERVER_DIR = SERVER_STORE_DIR;
const CREDENTIALS_FILE = path.join(SERVER_DIR, "admin-credentials.json");
const SESSION_SECRET_FILE = path.join(SERVER_DIR, "session-secret.json");

export const ADMIN_SESSION_COOKIE = "fs_admin_session";
export const ADMIN_SESSION_TTL_MS = 60 * 60_000; // 1 hour
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 5 * 60_000;

/* --------------------------- credentials bootstrap -------------------------- */

interface CredentialFile {
  username: string;
  scrypt: string; // N$r$p$saltB64$hashB64
  createdAt: number;
  bootstrapPasswordPrinted: boolean;
}

function scryptString(password: string, saltB64?: string): string {
  const salt = saltB64
    ? Buffer.from(saltB64, "base64")
    : randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(password.normalize("NFKC"), salt, 64, { N, r, p });
  return `${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyScryptString(password: string, stored: string): boolean {
  try {
    const [nStr, rStr, pStr, saltB64, hashB64] = stored.split("$");
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Loads (or bootstraps) admin credentials. Returns { username, scrypt }.
 * Bootstrap: a 24-char cryptographically random password is generated,
 * hashed, stored server-side, and printed ONCE to the server console.
 * It never appears in client code, responses or logs again.
 */
function loadCredentials(): CredentialFile {
  // 1) Operator-provided hash (highest priority — required for serverless
  //    deployments where the file store is per-instance/ephemeral, e.g.
  //    Vercel). Format: N$r$p$saltB64$hashB64 (see README for a generator).
  const envHash = process.env["ADMIN_PASSWORD_HASH"];
  const envHashTrimmed = envHash?.trim() ?? "";
  // Shape: N$r$p$saltB64$hashB64 (standard base64 pieces).
  if (/^\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(envHashTrimmed)) {
    return {
      username: process.env["ADMIN_USERNAME"] || "admin",
      scrypt: envHashTrimmed,
      createdAt: Date.now(),
      bootstrapPasswordPrinted: false,
    };
  }

  try {
    if (existsSync(CREDENTIALS_FILE)) {
      const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as CredentialFile;
      if (raw?.scrypt && raw?.username) return raw;
    }
  } catch {
    /* re-bootstrap below */
  }

  const bootstrapPassword = randomBytes(18).toString("base64url"); // 24 chars, 144 bits
  const record: CredentialFile = {
    username: process.env["ADMIN_USERNAME"] || "admin",
    scrypt: scryptString(bootstrapPassword),
    createdAt: Date.now(),
    bootstrapPasswordPrinted: true,
  };
  if (!existsSync(SERVER_DIR)) mkdirSync(SERVER_DIR, { recursive: true });
  const tmp = `${CREDENTIALS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_FILE);

  // One-time console print — the ONLY place the plaintext ever appears.
  console.log(
    JSON.stringify({
      severity: "NOTICE",
      message: "ADMIN_BOOTSTRAP_CREDENTIALS",
      note: "One-time developer-admin bootstrap password (CHANGE OR DELETE THIS FILE AFTER FIRST LOGIN). Regenerate by deleting .server/admin-credentials.json and restarting.",
      username: record.username,
      password: bootstrapPassword,
    })
  );
  return record;
}

/* ----------------------------- session signing ------------------------------ */

interface SessionSecret {
  secretB64: string;
  createdAt: number;
}

function loadSessionSecret(): Buffer {
  try {
    if (existsSync(SESSION_SECRET_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_SECRET_FILE, "utf8")) as SessionSecret;
      if (raw?.secretB64) return Buffer.from(raw.secretB64, "base64");
    }
  } catch {
    /* re-generate below */
  }
  const secret = randomBytes(32);
  if (!existsSync(SERVER_DIR)) mkdirSync(SERVER_DIR, { recursive: true });
  const tmp = `${SESSION_SECRET_FILE}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ secretB64: secret.toString("base64"), createdAt: Date.now() } satisfies SessionSecret, null, 2),
    { mode: 0o600 }
  );
  renameSync(tmp, SESSION_SECRET_FILE);
  return secret;
}

/** token = payloadB64.hmacB64 (payload: username + expiry, tamper-proof). */
export function issueSessionToken(username: string): string {
  const secret = loadSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + ADMIN_SESSION_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string | undefined): { username: string } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const secret = loadSessionSecret();
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u: string;
      exp: number;
    };
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { username: data.u };
  } catch {
    return null;
  }
}

/* --------------------------- parent session token --------------------------- */

export const PARENT_SESSION_COOKIE = "fs_parent_session";
const PARENT_SESSION_TTL_MS = 24 * 60 * 60_000;

/** Parent session (issued by /api/auth/login after REAL verification). */
export function issueParentToken(uid: string, email: string): string {
  const secret = loadSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({ uid, email: email.toLowerCase(), exp: Date.now() + PARENT_SESSION_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyParentToken(
  token: string | undefined
): { uid: string; email: string } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const secret = loadSessionSecret();
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      uid: string;
      email: string;
      exp: number;
    };
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { uid: data.uid, email: data.email };
  } catch {
    return null;
  }
}

/* ------------------------------- login core --------------------------------- */

export type AdminLoginVerdict =
  | { ok: true; token: string; username: string }
  | { ok: false; reason: "empty" | "invalid" | "locked"; retryAfterMs?: number };

/**
 * Server-side credential check + durable brute-force lockout
 * (5 fails → 5 min, shared ledger with the parent login).
 * The ONLY caller is POST /api/admin/login.
 */
export function adminLoginAttempt(
  username: string,
  password: string
): AdminLoginVerdict {
  const u = username.trim();
  if (!u || !password) return { ok: false, reason: "empty" };

  const buckets = [`admin-login:${u.toLowerCase()}`, "admin-login:global"];
  const verdict = checkLockout(buckets);
  if (!verdict.allowed) {
    return { ok: false, reason: "locked", retryAfterMs: verdict.retryAfterMs };
  }

  const creds = loadCredentials();
  const userOk = safeEqual(u, creds.username);
  const passOk = verifyScryptString(password, creds.scrypt);

  if (!userOk || !passOk) {
    recordFailedAttempt(buckets, ADMIN_MAX_ATTEMPTS, ADMIN_LOCKOUT_MS);
    return { ok: false, reason: "invalid" };
  }

  clearAttempts(buckets);
  return { ok: true, token: issueSessionToken(creds.username), username: creds.username };
}

/** Timing-safe equality with length-leak damping. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
