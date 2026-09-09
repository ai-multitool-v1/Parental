/**
 * POST /api/admin/logout — clears the admin session cookie.
 */
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
