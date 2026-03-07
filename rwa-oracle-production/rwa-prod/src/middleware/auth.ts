// src/adm../middleware/auth.ts
// ─────────────────────────────────────────────────────────────
//  Authentication & Authorization middleware
//
//  requireAuth     — verifies Bearer JWT access token
//  requireRole     — RBAC role guard (checks hierarchy)
//  requireApiKey   — verifies rwa_*** API key for feeder routes
// ─────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { prisma } from "../config/prisma";
import { hashToken } from "../utils/crypto";
import { logger } from "../utils/logger";

// Role hierarchy — higher index = more permissions
const ROLE_ORDER: Role[] = ["VIEWER", "OPERATOR", "ADMIN", "SUPER_ADMIN"];

function roleAtLeast(userRole: Role, required: Role): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(required);
}

// ── Types ─────────────────────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: Role;
  };
}

// ── JWT access token verification ─────────────────────────────
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.split(" ")[1];
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error("JWT_ACCESS_SECRET not configured");

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret) as jwt.JwtPayload;
    } catch (err: any) {
      const message =
        err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
      res.status(401).json({ error: message });
      return;
    }

    // Load user from DB to get current role and check if still active
    const user = await prisma.user.findUnique({
      where: { id: payload.sub as string },
      select: { id: true, email: true, role: true, active: true },
    });

    if (!user || !user.active) {
      res.status(401).json({ error: "User not found or deactivated" });
      return;
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (err: any) {
    logger.error(`Auth middleware error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── RBAC role guard ───────────────────────────────────────────
export function requireRole(minimumRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roleAtLeast(user.role, minimumRole)) {
      res.status(403).json({
        error: `Requires role: ${minimumRole}. Your role: ${user.role}`,
      });
      return;
    }
    next();
  };
}

// ── API key verification ───────────────────────────────────────
// Used by the feeder process to authenticate price submissions via API.
// Header: Authorization: ApiKey rwa_xxxxxxxx_...
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("ApiKey ")) {
      res.status(401).json({ error: "Missing ApiKey authorization" });
      return;
    }

    const raw = authHeader.split(" ")[1];
    if (!raw?.startsWith("rwa_")) {
      res.status(401).json({ error: "Invalid API key format" });
      return;
    }

    const hash = hashToken(raw);
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hash },
      include: { user: { select: { id: true, email: true, role: true, active: true } } },
    });

    if (!apiKey || !apiKey.active || !apiKey.user.active) {
      res.status(401).json({ error: "Invalid or revoked API key" });
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      res.status(401).json({ error: "API key expired" });
      return;
    }

    // Update last used (fire and forget)
    prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: {
          lastUsedAt: new Date(),
          lastUsedIp: req.socket?.remoteAddress ?? null,
        },
      })
      .catch((err) => logger.warn(`Failed to update apiKey lastUsed: ${err.message}`));

    (req as AuthenticatedRequest).user = {
      id: apiKey.user.id,
      email: apiKey.user.email,
      role: apiKey.user.role,
    };

    next();
  } catch (err: any) {
    logger.error(`ApiKey middleware error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Scope check for API keys ──────────────────────────────────
export function requireScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("ApiKey ")) {
      next(); // JWT users bypass scope check — they use RBAC instead
      return;
    }

    const raw = authHeader.split(" ")[1];
    const hash = hashToken(raw);
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hash },
      select: { scopes: true },
    });

    if (!apiKey || !apiKey.scopes.includes(scope)) {
      res.status(403).json({ error: `API key missing required scope: ${scope}` });
      return;
    }
    next();
  };
}
