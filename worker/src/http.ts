/**
 * http.ts — error contract + CORS + JSON plumbing.
 *
 * Error codes mirror Cloud Functions' HttpsError so the Android client's
 * message mapping (PairingManager.describeError etc.) ports 1:1.
 */

export type ApiErrorCode =
  | "unauthenticated"
  | "permission-denied"
  | "invalid-argument"
  | "not-found"
  | "failed-precondition"
  | "resource-exhausted"
  | "already-exists"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  "permission-denied": 403,
  "invalid-argument": 400,
  "not-found": 404,
  "failed-precondition": 400,
  "resource-exhausted": 429,
  "already-exists": 409,
  unavailable: 503,
  internal: 500,
};

/** Mirrors functions' HttpsError so handler code ports 1:1. */
export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string) {
    super(message);
  }
  status(): number {
    return STATUS[this.code];
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extraHeaders ?? {}),
    },
  });
}

export function errorResponse(err: unknown, corsHeaders: HeadersInit): Response {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message } },
      err.status(),
      corsHeaders
    );
  }
  console.error(
    JSON.stringify({
      severity: "ERROR",
      message: "worker_unhandled_error",
      error: err instanceof Error ? err.message : String(err),
    })
  );
  // Sanitized snippet (name + short generic message) — internal errors are
  // bug reports, not secret material, and this makes field debugging possible.
  const name = err instanceof Error ? err.name : "Error";
  const detail = (err instanceof Error ? err.message : String(err))
    .slice(0, 600)
    .replace(/\s+/g, " ")
    .trim();
  // First meaningful stack frames (file:line) — pinpoints which dependency
  // threw without leaking any data.
  const frames = (err instanceof Error ? err.stack ?? "" : "")
    .split("\n")
    .filter((l) => l.includes("at "))
    .slice(0, 4)
    .map((l) => l.trim().replace(/\s+/g, " ").slice(0, 90))
    .join(" | ");
  return json(
    {
      error: {
        code: "internal",
        message: `Internal error. Try again. [${name}] ${detail}${frames ? " §" + frames : ""}`,
      },
    },
    500,
    corsHeaders
  );
}

/** CORS for browser dashboard calls; native Android calls ignore CORS. */
export function corsHeaders(allowedOrigins: string | undefined, origin: string | null): HeadersInit {
  const list = (allowedOrigins ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = list.includes("*") ? "*" : origin && list.includes(origin) ? origin : list[0] ?? "";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-firebase-appcheck",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function preflight(headers: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}
