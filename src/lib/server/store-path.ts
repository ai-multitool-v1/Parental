import "server-only";
/**
 * server/store-path.ts — writable directory resolver for all server-side
 * file-backed stores (auth users, admin credentials/registry, attempt
 * ledger, session secret).
 *
 * WHY: these stores persist at `<cwd>/.server/` — perfect for a long-running
 * server (VPS/self-host), but serverless platforms (Vercel) mount the
 * deployment directory READ-ONLY, so writes throw EROFS and silently lose
 * data (signup would appear to succeed yet persist nothing).
 *
 * Resolution order:
 *   1. AUTH_STORE_DIR env var (explicit operator control)
 *   2. <cwd>/.server (self-host / dev — keeps files next to the project)
 *   3. os.tmpdir()/parental-control-server (serverless fallback — writable,
 *      but PER-INSTANCE and ephemeral: fine for demo mode; production
 *      deployments needing durable state must set AUTH_STORE_DIR to a
 *      mounted volume or self-host. See README "Deployment" section.)
 *
 * SECURITY: the chosen directory must be chmod 0700 and every file written
 * into it uses mode 0600 (enforced by each store's save function).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, ".write-probe");
    writeFileSync(probe, "ok", { mode: 0o600 });
    return existsSync(probe);
  } catch {
    return false;
  }
}

function resolveServerStoreDir(): string {
  const candidates: string[] = [];
  const custom = process.env["AUTH_STORE_DIR"];
  if (custom && custom.trim()) candidates.push(custom.trim());
  candidates.push(path.join(process.cwd(), ".server"));
  candidates.push(path.join(os.tmpdir(), "parental-control-server"));

  for (const dir of candidates) {
    if (isWritable(dir)) return dir;
  }
  // Last resort: return tmp path anyway — individual stores degrade
  // gracefully (they already treat write failures as non-fatal).
  return path.join(os.tmpdir(), "parental-control-server");
}

export const SERVER_STORE_DIR = resolveServerStoreDir();
