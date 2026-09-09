/**
 * server/attempt-ledger.ts — durable brute-force lockout ledger (v1.4.1).
 *
 * In-memory Maps are NOT reliable here: dev hot-reload (and prod multi-
 * instance) re-instantiates module state, silently resetting attempt
 * counters. This file-backed ledger survives reloads/restarts; each record
 * is atomic-renamed like the other server stores.
 *
 * Records keyed by hashed bucket ("email:x", "ip:y", "admin-login:z") —
 * no PII in filenames. Used by /api/auth/login AND /api/admin/login with
 * the SAME 5-fails → 5-minute pattern as the admin console convention.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { SERVER_STORE_DIR } from "./store-path";

const SERVER_DIR = SERVER_STORE_DIR;
const LEDGER_FILE = path.join(SERVER_DIR, "attempt-ledger.json");

export interface LockRecord {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

interface LedgerFile {
  version: 1;
  records: Record<string, LockRecord>;
}

const EMPTY: LedgerFile = { version: 1, records: {} };

function loadLedger(): LedgerFile {
  try {
    if (existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as LedgerFile;
      if (raw && raw.records && typeof raw.records === "object") return raw;
    }
  } catch {
    /* corrupted → fresh */
  }
  return { ...EMPTY, records: {} };
}

function saveLedger(ledger: LedgerFile): void {
  try {
    if (!existsSync(SERVER_DIR)) mkdirSync(SERVER_DIR, { recursive: true });
    const tmp = `${LEDGER_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(tmp, LEDGER_FILE);
  } catch (err) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        message: "attempt_ledger_write_failed",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

function hashBucket(bucket: string): string {
  return createHash("sha256").update(bucket).digest("hex").slice(0, 32);
}

export type AttemptVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** True unless ANY bucket is currently locked. */
export function checkLockout(buckets: string[]): AttemptVerdict {
  const now = Date.now();
  const ledger = loadLedger();
  for (const bucket of buckets) {
    const rec = ledger.records[hashBucket(bucket)];
    if (rec && rec.lockedUntil > now) {
      return { allowed: false, retryAfterMs: rec.lockedUntil - now };
    }
  }
  return { allowed: true };
}

/** Records one FAILED attempt per bucket; engages lockout at the threshold. */
export function recordFailedAttempt(
  buckets: string[],
  maxAttempts = 5,
  lockoutMs = 5 * 60_000
): void {
  const now = Date.now();
  const ledger = loadLedger();
  for (const bucket of buckets) {
    const key = hashBucket(bucket);
    const rec = ledger.records[key];
    if (!rec || now - rec.firstAt > lockoutMs) {
      ledger.records[key] = { count: 1, firstAt: now, lockedUntil: 0 };
      continue;
    }
    rec.count += 1;
    if (rec.count >= maxAttempts) {
      rec.lockedUntil = now + lockoutMs;
      rec.count = 0;
      rec.firstAt = now;
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "auth_lockout_engaged",
          scope: bucket.split(":")[0],
        })
      );
    }
    ledger.records[key] = rec;
  }
  saveLedger(ledger);
}

/** Clears failures for the buckets (on successful auth). */
export function clearAttempts(buckets: string[]): void {
  const ledger = loadLedger();
  let changed = false;
  for (const bucket of buckets) {
    const key = hashBucket(bucket);
    if (ledger.records[key]) {
      delete ledger.records[key];
      changed = true;
    }
  }
  if (changed) saveLedger(ledger);
}
