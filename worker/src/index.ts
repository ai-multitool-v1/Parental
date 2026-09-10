/**
 * index.ts — Cloudflare Worker entrypoint (Hono router).
 *
 *   POST /api/secure/:name   authenticated privileged API (Android + web)
 *   PUT  /backup/put?k&e&s   HMAC-signed short-lived R2 upload proxy
 *   GET  /backup/get?k&e&s   HMAC-signed short-lived R2 download proxy
 *   cron trigger             → runSweep() (expire/cleanup/retention/escalation)
 *
 * EVERY /api/secure request is authenticated with a verified Firebase ID
 * token and authorized server-side (pairing links + ban/plan gates) — the
 * Worker is "trusted" only because every client assertion is re-verified
 * here; nothing about the caller is taken on faith.
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { ApiError, corsHeaders, errorResponse, json, preflight } from "./http";
import { bindEnv, verifyCaller, type Caller } from "./admin";
import {
  adminSetBanState,
  adminSetPlan,
  backupCompleteUpload,
  backupCreateUploadUrl,
  backupGetDownloadUrl,
  backupGetKey,
  backupListForChild,
  backupSetPolicy,
  commandResult,
  confirmPairing,
  dispatchCommand,
  endSession,
  generatePairingCode,
  profile,
  requestSession,
  runSweep,
  sendParentNotification,
  type Handler,
} from "./handlers";

const app = new Hono<{ Bindings: Env }>();

/* ───────────────────────────── CORS middleware ──────────────────────────── */

app.use("*", async (c, next) => {
  const headers = corsHeaders(c.env.ALLOWED_ORIGINS, c.req.header("origin") ?? null);
  if (c.req.method === "OPTIONS") {
    return preflight(headers);
  }
  await next();
  for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
});

/** Central error → { error: { code, message } } mapping (with CORS). */
app.onError((err, c) => {
  const headers = corsHeaders(c.env.ALLOWED_ORIGINS, c.req.header("origin") ?? null);
  return errorResponse(err, headers);
});

/* ─────────────────────────── secure API dispatcher ──────────────────────── */

const HANDLERS: Record<string, Handler> = {
  profile,
  generatePairingCode,
  confirmPairing,
  dispatchCommand,
  commandResult,
  requestSession,
  endSession,
  sendParentNotification,
  backupSetPolicy,
  backupGetKey,
  backupCreateUploadUrl,
  backupCompleteUpload,
  backupGetDownloadUrl,
  backupListForChild,
  adminSetBanState,
  adminSetPlan,
};

app.post("/api/secure/:name", async (c) => {
  bindEnv(c.env);
  const name = c.req.param("name");

  // `/api/secure/sweep` is admin-only (manual trigger; cron bypasses HTTP).
  if (name === "sweep") {
    const caller = await verifyCaller(c.req.raw);
    if (caller.token["admin"] !== true) {
      throw new ApiError("permission-denied", "Admin privileges required.");
    }
    return json({ ok: true, summary: await runSweep() });
  }

  const handler = HANDLERS[name];
  if (!handler) {
    throw new ApiError("not-found", `Unknown endpoint "${name}".`);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = (await c.req.json()) as Record<string, unknown>;
    // Callable-SDK compatibility: accept both `{data: …}` and a flat payload.
    body =
      parsed && typeof parsed === "object" && parsed["data"] !== undefined
        ? (parsed["data"] as Record<string, unknown>)
        : parsed ?? {};
  } catch {
    body = {};
  }

  const caller: Caller = await verifyCaller(c.req.raw);
  const result = await handler(c.env, caller, body, c.req.raw);
  return json({ ok: true, data: result });
});

/* ─────────────────────────── R2 proxy (signed URLs) ─────────────────────── */

app.put("/backup/put", async (c) => {
  const { verifySignature } = await import("./backupurls");
  const k = c.req.query("k") ?? "";
  const e = c.req.query("e") ?? "";
  const s = c.req.query("s") ?? "";
  if (!k || !e || !s) {
    throw new ApiError("invalid-argument", "Missing signed-URL parameters.");
  }
  await verifySignature(c.env, "PUT", k, e, s);

  if (!c.req.header("content-length")) {
    throw new ApiError("invalid-argument", "Content-Length required.");
  }
  await c.env.BACKUP_BUCKET.put(k, c.req.raw.body as ReadableStream);
  return json({ ok: true });
});

app.get("/backup/get", async (c) => {
  const { verifySignature } = await import("./backupurls");
  const k = c.req.query("k") ?? "";
  const e = c.req.query("e") ?? "";
  const s = c.req.query("s") ?? "";
  if (!k || !e || !s) {
    throw new ApiError("invalid-argument", "Missing signed-URL parameters.");
  }
  await verifySignature(c.env, "GET", k, e, s);

  const obj = await c.env.BACKUP_BUCKET.get(k);
  if (!obj) {
    throw new ApiError("not-found", "Object missing.");
  }
  return new Response(obj.body as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "private, max-age=300",
      "content-disposition": `attachment; filename="${k.split("/").pop() ?? "backup"}"`,
    },
  });
});

/* ─────────────────────────────── health check ───────────────────────────── */

app.get("/", (c) => json({ ok: true, service: "parental-control-api" }));

/* ──────────────────────────── scheduled (cron) ──────────────────────────── */

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // Rebind process.env for the Admin SDK (Workers secrets surface there).
    const g = globalThis as unknown as Record<string, unknown>;
    g.process ??= {};
    (g.process as Record<string, unknown>).env ??= {};
    const penv = (g.process as Record<string, unknown>).env as Record<string, string>;
    penv.FIREBASE_SERVICE_ACCOUNT_JSON ??= env.FIREBASE_SERVICE_ACCOUNT_JSON;
    try {
      const summary = await runSweep();
      console.log(JSON.stringify({ severity: "INFO", message: "cron_sweep_done", summary }));
    } catch (err) {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: "cron_sweep_failed",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  },
};

export { app };
