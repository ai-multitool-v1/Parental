/**
 * POST /api/auth/signup — real parent account registration (v1.4.1).
 *
 * CRITICAL FIX #1: replaces the old "any email + any password creates and
 * logs into an account" demo behavior. Validation + scrypt hashing + a
 * persisted server-side store. Duplicate emails are rejected.
 */
import { NextResponse } from "next/server";
import { AuthError, signupUser } from "@/lib/server/auth-users";
import { registerSignedUpUser } from "@/lib/server/admin-registry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_JSON" }, { status: 400 });
  }

  const name = typeof body["name"] === "string" ? body["name"] : "";
  const email = typeof body["email"] === "string" ? body["email"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  const confirm = typeof body["confirm"] === "string" ? body["confirm"] : "";

  if (password !== confirm) {
    return NextResponse.json({ ok: false, error: "PASSWORD_MISMATCH" }, { status: 400 });
  }

  try {
    const user = signupUser(name, email, password);
    // Mirror into the admin registry so the Developer Console sees the
    // registration immediately (server-side truth, no client writes).
    registerSignedUpUser(user);
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ ok: false, error: err.code }, { status: 400 });
    }
    console.error(
      JSON.stringify({ severity: "ERROR", message: "signup_failed", error: err instanceof Error ? err.message : String(err) })
    );
    return NextResponse.json({ ok: false, error: "INTERNAL" }, { status: 500 });
  }
}
