// src/middleware/security.ts — Security middleware stack (PRODUCTION)
//  1. httpsRedirect    — force HTTPS in production
//  2. helmetMiddleware — secure HTTP headers (CSP, HSTS, etc.)
//  3. globalRateLimit  — 200 req/15min per IP
//  4. authRateLimit    — 10 req/15min per IP on auth routes
//  5. sanitizeBody     — strip $-prefixed keys
//  6. auditMiddleware  — immutable audit log on every mutating request

import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";

// ── 1. HTTPS redirect ─────────────────────────────────────────
export function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
  if (
    process.env.NODE_ENV === "production" &&
    req.headers["x-forwarded-proto"] !== "https"
  ) {
    res.redirect(301, `https://${req.headers.host}${req.url}`);
    return;
  }
  next();
}

// ── 2. Helmet ─────────────────────────────────────────────────
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      mediaSrc:   ["'none'"],
      frameSrc:   ["'none'"],
    },
  },
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: "deny" },
  noSniff: true,
});

// ── 3. Global rate limit ──────────────────────────────────────
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

// ── 4. Auth rate limit ────────────────────────────────────────
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  skip: () => process.env.NODE_ENV === "test",
});

// ── 5. Body sanitizer ─────────────────────────────────────────
export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object") {
    req.body = deepSanitize(req.body);
  }
  next();
}

function deepSanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith("$") || key.includes(".")) continue;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      clean[key] = deepSanitize(val as Record<string, unknown>);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

// ── 6. Audit log middleware ────────────────────────────────────
// Uses a response-finish listener instead of overriding res.end,
// which is safer with Express 5 and streaming responses.
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mutating = ["POST", "PUT", "PATCH", "DELETE"];
  if (!mutating.includes(req.method)) {
    next();
    return;
  }

  // Snapshot body now before it may be modified by route handlers
  const bodySnapshot = sanitizeMetadata(req.body);

  res.on("finish", () => {
    const userId  = (req as any).user?.id ?? null;
    const success = res.statusCode < 400;
    const action  = `${req.method}:${req.path}`;

    prisma.auditLog
      .create({
        data: {
          userId,
          action,
          resource:  req.path,
          ipAddress: getIp(req),
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            method:     req.method,
            statusCode: res.statusCode,
            body:       bodySnapshot,
            params:     req.params,
          },
          success,
          errorMsg: success ? null : `HTTP ${res.statusCode}`,
        },
      })
      .catch((err) => logger.error(`AuditLog write failed: ${err.message}`));
  });

  next();
}

export function getIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function sanitizeMetadata(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const sensitive = ["password", "passwordHash", "token", "secret", "key", "mfaSecret"];
  const clean = { ...(body as Record<string, unknown>) };
  for (const field of sensitive) {
    if (field in clean) clean[field] = "[REDACTED]";
  }
  return clean;
}
