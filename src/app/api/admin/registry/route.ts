/**
 * /api/admin/registry — server-authoritative Developer-Admin registry
 * (v1.4.1, CRITICAL FIX #2).
 *
 *   GET  → full snapshot { users, devices, audit }   (admin cookie REQUIRED)
 *   POST → apply one admin action (ban/unban/setPlan/forceLogout/device
 *          registration) and return the fresh snapshot.
 *
 * This replaces the old client-side sessionStorage "registry" — ban/plan
 * state is now a server-side security boundary. Client tampering has no
 * effect: parent login and command gating read the SERVER store.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  PARENT_SESSION_COOKIE,
  verifyParentToken,
  verifySessionToken,
} from "@/lib/server/admin-auth";
import {
  ActionResult,
  AdminAction,
  readRegistry,
  registerDevice,
  applyAdminAction,
} from "@/lib/server/admin-registry";

export const runtime = "nodejs";

async function requireAdmin(): Promise<NextResponse | null> {
  const store = await cookies();
  const session = verifySessionToken(store.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  return NextResponse.json({ ok: true, ...readRegistry() });
}

interface DeviceRegistrationPayload {
  id: string;
  name: string;
  ownerEmail: string;
  model: string;
}

function isDevicePayload(v: unknown): v is DeviceRegistrationPayload {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d["id"] === "string" &&
    /^[A-Za-z0-9-]{10,64}$/.test(d["id"]) &&
    typeof d["name"] === "string" && d["name"].length <= 64 &&
    typeof d["ownerEmail"] === "string" && d["ownerEmail"].length <= 128 &&
    typeof d["model"] === "string" && d["model"].length <= 64
  );
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_JSON" }, { status: 400 });
  }

  const type = body["type"];

  /* ---- device registration (pairing flow) — MUST run BEFORE the admin
          gate: allowed with EITHER an admin session OR a parent session
          whose email matches the device owner. Anything else → 401.
          (Prevents anonymous registry pollution.) --- */
  if (type === "registerDevice") {
    const payload = body["device"];
    if (!isDevicePayload(payload)) {
      return NextResponse.json({ ok: false, error: "BAD_PAYLOAD" }, { status: 400 });
    }
    const jar = await cookies();
    const admin = verifySessionToken(jar.get(ADMIN_SESSION_COOKIE)?.value);
    const parent = verifyParentToken(jar.get(PARENT_SESSION_COOKIE)?.value);
    const authorized =
      admin !== null ||
      (parent !== null && parent.email === payload.ownerEmail.toLowerCase());
    if (!authorized) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
    registerDevice(payload);
    return NextResponse.json({ ok: true, ...readRegistry() });
  }

  /* ---- admin mutations (admin session REQUIRED) ---- */
  const denied = await requireAdmin();
  if (denied) return denied;

  const action = parseAction(body);
  if (!action) {
    return NextResponse.json({ ok: false, error: "BAD_ACTION" }, { status: 400 });
  }
  const result: ActionResult = applyAdminAction(action);
  if (!result.ok && result.error) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.error === "not_found" ? 404 : 403 }
    );
  }
  return NextResponse.json({ ok: true, ...(result.snapshot ?? readRegistry()) });
}

function parseAction(body: Record<string, unknown>): AdminAction | null {
  const type = body["type"];
  const uid = typeof body["uid"] === "string" ? body["uid"] : "";
  const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : "";
  const reason =
    typeof body["reason"] === "string"
      ? body["reason"].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 280)
      : "";

  switch (type) {
    case "banUser":
      return uid ? { type: "banUser", uid, reason } : null;
    case "unbanUser":
      return uid ? { type: "unbanUser", uid } : null;
    case "banDevice":
      return deviceId ? { type: "banDevice", deviceId, reason } : null;
    case "unbanDevice":
      return deviceId ? { type: "unbanDevice", deviceId } : null;
    case "forceLogout":
      return uid ? { type: "forceLogout", uid } : null;
    case "setPlan": {
      const plan = body["plan"];
      if (!uid || (plan !== "free" && plan !== "premium")) return null;
      return { type: "setPlan", uid, plan };
    }
    default:
      return null;
  }
}
