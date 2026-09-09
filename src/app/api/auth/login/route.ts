/**
 * POST /api/auth/login — real parent login with password verification
 * (v1.4.1, CRITICAL FIX #1).
 *
 * Response contract:
 *   200 { ok: true, user }                    — verified + not banned
 *   401 { ok: false, error: "NO_ACCOUNT" }    — unregistered email
 *   401 { ok: false, error: "WRONG_PASSWORD" }— hash mismatch
 *   403 { ok: false, error: "BANNED" }        — admin-banned account
 *   429 { ok: false, error: "LOCKED", retryAfterMs } — 5 fails → 5 min
 *
 * Per-email AND per-IP lockout buckets; failed attempts are recorded on
 * every failure path, cleared on success. Coarse per-IP throttle prevents
 * credential-stuffing across many emails from one address.
 */
import { NextResponse } from "next/server";
import {
  AuthError,
  checkLockout,
  clearAttempts,
  loginBuckets,
  recordFailedAttempt,
  verifyLogin,
} from "@/lib/server/auth-users";
import {
  getUserPlanByEmail,
  isEmailBanned,
  markParentLogin,
} from "@/lib/server/admin-registry";
import {
  PARENT_SESSION_COOKIE,
  issueParentToken,
} from "@/lib/server/admin-auth";

export const runtime = "nodejs";

/** Coarse per-IP bucket — slows mass credential-stuffing. */
function ipBuckets(request: Request): string[] {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || "local";
  return [`ip:${ip}`];
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_JSON" }, { status: 400 });
  }

  const email = typeof body["email"] === "string" ? body["email"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  if (!email.trim() || !password) {
    return NextResponse.json({ ok: false, error: "EMPTY" }, { status: 400 });
  }

  const buckets = [...loginBuckets(email), ...ipBuckets(request)];

  // Lockout check FIRST (fail closed while locked).
  const verdict = checkLockout(buckets);
  if (!verdict.allowed) {
    return NextResponse.json(
      { ok: false, error: "LOCKED", retryAfterMs: verdict.retryAfterMs },
      { status: 429 }
    );
  }

  try {
    const { user } = verifyLogin(email, password);
    // Ban + plan: the ADMIN REGISTRY is the authoritative source (admin
    // bans/plan grants apply instantly, even mid-session).
    if (isEmailBanned(user.email)) {
      recordFailedAttempt(buckets);
      return NextResponse.json({ ok: false, error: "BANNED" }, { status: 403 });
    }
    clearAttempts(buckets);
    const stored = markParentLogin(user.email); // server-side live-session truth
    const plan = getUserPlanByEmail(user.email) ?? user.plan;
    const res = NextResponse.json({
      ok: true,
      user: { ...user, plan, online: stored?.online ?? true },
    });
    // Parent session cookie (httpOnly) — authorizes device-registration
    // mirroring from the pairing flow; carries no privileged rights.
    res.cookies.set({
      name: PARENT_SESSION_COOKIE,
      value: issueParentToken(user.uid, user.email),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env["NODE_ENV"] === "production",
      path: "/",
      maxAge: 24 * 60 * 60,
    });
    return res;
  } catch (err) {
    if (err instanceof AuthError) {
      recordFailedAttempt(buckets);
      const status = err.code === "BANNED" ? 403 : 401;
      return NextResponse.json({ ok: false, error: err.code }, { status });
    }
    console.error(
      JSON.stringify({ severity: "ERROR", message: "login_failed", error: err instanceof Error ? err.message : String(err) })
    );
    return NextResponse.json({ ok: false, error: "INTERNAL" }, { status: 500 });
  }
}
