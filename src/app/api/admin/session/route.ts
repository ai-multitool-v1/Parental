/**
 * GET /api/admin/session — validates the admin session cookie.
 * The client uses this to restore admin UI state on mount; the browser can
 * read nothing (httpOnly) — the server is the only verifier.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, verifySessionToken } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

export async function GET() {
  const store = await cookies();
  const session = verifySessionToken(store.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, username: session.username });
}
