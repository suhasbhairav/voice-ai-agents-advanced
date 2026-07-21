import { NextResponse } from "next/server";

const WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000);
const MAX_REQUESTS = Number(process.env.API_RATE_LIMIT_MAX || 60);
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES || 1_000_000);
const buckets = new Map();

function clientId(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

function rateLimit(id) {
  const now = Date.now();
  const current = buckets.get(id);

  if (!current || current.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: MAX_REQUESTS - 1, resetAt: now + WINDOW_MS };
  }

  current.count += 1;
  return {
    ok: current.count <= MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - current.count),
    resetAt: current.resetAt,
  };
}

function withSecurityHeaders(response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function proxy(request) {
  const method = request.method.toUpperCase();
  const contentLength = Number(request.headers.get("content-length") || 0);

  if (["POST", "PUT", "PATCH"].includes(method) && contentLength > MAX_BODY_BYTES) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Request body is too large." }, { status: 413 }),
    );
  }

  const contentType = request.headers.get("content-type") || "";
  if (["POST", "PUT", "PATCH"].includes(method)) {
    const allowed =
      contentType.includes("application/json") ||
      contentType.includes("multipart/form-data") ||
      contentType.includes("text/plain");

    if (contentType && !allowed) {
      return withSecurityHeaders(
        NextResponse.json({ error: "Unsupported content type." }, { status: 415 }),
      );
    }
  }

  const bucket = rateLimit(clientId(request));
  if (!bucket.ok) {
    return withSecurityHeaders(
      NextResponse.json(
        { error: "Too many requests. Please slow down and try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))),
          },
        },
      ),
    );
  }

  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Limit", String(MAX_REQUESTS));
  response.headers.set("X-RateLimit-Remaining", String(bucket.remaining));
  return withSecurityHeaders(response);
}

export const config = {
  matcher: "/api/:path*",
};
