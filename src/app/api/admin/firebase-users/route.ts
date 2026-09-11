/**
 * /api/admin/firebase-users — REAL Firebase account management for the
 * Developer Admin console (v1.4.2).
 *
 *   GET  → proxy Worker `adminListUsers`  (real Auth accounts + plan/banned)
 *   POST → proxy Worker `adminDeleteUser` / `adminSetPlan` / `adminSetBanState`
 *
 * Auth chain (both hops mandatory):
 *   1. Browser → here: the admin session cookie (fs_admin_session) is verified.
 *   2. Here  → Worker: the shared `WORKER_ADMIN_SECRET` header (x-admin-secret)
 *      grants the admin endpoints WITHOUT any Firebase ID token. The secret is
 *      server-only (Vercel + Cloudflare env) — it never reaches the browser.
 *
 * Without WORKER_ADMIN_SECRET configured the route answers {configured:false}
 * so the console can show a setup hint instead of fake data.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, verifySessionToken } from "@/lib/server/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workerBase(): string {
  const base =
    process.env.SECURE_API_BASE ??
    process.env.NEXT_PUBLIC_SECURE_API_BASE ??
    "";
  return base.trim().replace(/\/$/, "");
}

async function requireAdmin(): Promise<NextResponse | null> {
  const store = await cookies();
  const session = verifySessionToken(store.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}

async function callWorkerAdmin(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const secret = process.env.WORKER_ADMIN_SECRET ?? "";
  const base = workerBase();
  if (!secret || !base) {
    return { status: 503, data: { ok: false, configured: false } };
  }
  const res = await fetch(`${base}/api/secure/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify({ data: body }),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = { ok: false };
  }
  return { status: res.status, data };
}

export async function GET(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const url = new URL(request.url);
  const maxResults = Number(url.searchParams.get("maxResults") ?? 500);
  const { status, data } = await callWorkerAdmin("adminListUsers", {
    maxResults: Number.isFinite(maxResults) ? maxResults : 500,
  });
  return NextResponse.json(data, { status });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_JSON" }, { status: 400 });
  }

  const action = body["action"];
  const uid = typeof body["uid"] === "string" ? (body["uid"] as string) : "";

  if ((action === "delete" || action === "plan" || action === "ban") && uid.length < 8) {
    return NextResponse.json({ ok: false, error: "BAD_UID" }, { status: 400 });
  }

  if (action === "delete") {
    const { status, data } = await callWorkerAdmin("adminDeleteUser", { targetUid: uid });
    return NextResponse.json(data, { status });
  }
  if (action === "plan") {
    const plan = body["plan"];
    if (plan !== "free" && plan !== "premium") {
      return NextResponse.json({ ok: false, error: "BAD_PLAN" }, { status: 400 });
    }
    const { status, data } = await callWorkerAdmin("adminSetPlan", { targetUid: uid, plan });
    return NextResponse.json(data, { status });
  }
  if (action === "ban") {
    const banned = body["banned"] === true;
    const reason = typeof body["reason"] === "string" ? (body["reason"] as string) : "No reason provided";
    const { status, data } = await callWorkerAdmin("adminSetBanState", {
      targetType: "user",
      targetId: uid,
      banned,
      reason,
    });
    return NextResponse.json(data, { status });
  }

  return NextResponse.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
}
