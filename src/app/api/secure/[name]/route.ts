/**
 * POST /api/secure/[name] — same-origin proxy to the Cloudflare Worker.
 *
 * WHY THIS EXISTS (ISP-block fallback):
 *   Some ISPs (notably in Bangladesh) intermittently block/throttle
 *   `*.workers.dev` at the DNS/SNI level. The parent dashboard itself is
 *   served from vercel.app (always reachable), so when the browser cannot
 *   reach the Worker directly, callSecure() in src/lib/family/real.ts
 *   automatically retries through THIS route: browser → Vercel function →
 *   Worker (server-to-server, unaffected by the user's ISP).
 *
 * Security:
 *   - Endpoint allowlist (no open proxy / no SSRF).
 *   - Only the `authorization` header is forwarded; the Firebase ID token
 *     still guards every privileged operation ON the Worker.
 *   - No request caching (force-dynamic).
 *
 * Response: the Worker's JSON body + HTTP status, passed through verbatim.
 */
import { NextRequest, NextResponse } from "next/server";

/** Exact handler names registered on the Worker (worker/src/index.ts). */
const ALLOWED_ENDPOINTS = new Set([
  "profile",
  "generatePairingCode",
  "confirmPairing",
  "dispatchCommand",
  "commandResult",
  "requestSession",
  "endSession",
  "sendParentNotification",
  "listDevices",
  "setPolicy",
  "unpairDevice",
  "backupSetPolicy",
  "backupGetKey",
  "backupCreateUploadUrl",
  "backupCompleteUpload",
  "backupGetDownloadUrl",
  "backupListForChild",
  "adminSetBanState",
  "adminSetPlan",
  "sweep",
]);

/** Worker base URL — runtime env (works on Vercel serverless; never inlined). */
function workerBase(): string {
  const base =
    process.env.SECURE_API_BASE ??
    process.env.NEXT_PUBLIC_SECURE_API_BASE ??
    "";
  return base.trim().replace(/\/$/, "");
}

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> }
) {
  const { name } = await ctx.params;

  if (!ALLOWED_ENDPOINTS.has(name)) {
    return NextResponse.json(
      { ok: false, error: { code: "not-found", message: `Unknown endpoint "${name}".` } },
      { status: 404 }
    );
  }

  const base = workerBase();
  if (!base) {
    return NextResponse.json(
      { ok: false, error: { code: "internal", message: "Proxy misconfigured: SECURE_API_BASE missing." } },
      { status: 500 }
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Sign in first." } },
      { status: 401 }
    );
  }

  let body = "{}";
  try {
    body = await req.text();
  } catch {
    body = "{}";
  }

  try {
    const upstream = await fetch(`${base}/api/secure/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
      },
      body,
      // AbortSignal.timeout: Node 22+ runtime supports it.
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "network",
          message: `Proxy could not reach the Worker. (${detail})`,
        },
      },
      { status: 502 }
    );
  }
}
