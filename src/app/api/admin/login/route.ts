/**
 * POST /api/admin/login — server-side Developer-Admin authentication
 * (v1.4.1, CRITICAL FIX #2).
 *
 * The credentials live ONLY on the server (scrypt hash at
 * .server/admin-credentials.json; one-time bootstrap password printed to
 * the server console on first boot). NOTHING here is reachable from the
 * client bundle. Success sets an httpOnly signed session cookie.
 */
import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  adminLoginAttempt,
} from "@/lib/server/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "empty" }, { status: 400 });
  }

  const username = typeof body["username"] === "string" ? body["username"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";

  const verdict = adminLoginAttempt(username, password);
  if (!verdict.ok) {
    const status =
      verdict.reason === "locked" ? 429 : verdict.reason === "empty" ? 400 : 401;
    return NextResponse.json(
      { ok: false, reason: verdict.reason, retryAfterMs: verdict.retryAfterMs },
      { status }
    );
  }

  const res = NextResponse.json({ ok: true, username: verdict.username });
  res.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: verdict.token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return res;
}
