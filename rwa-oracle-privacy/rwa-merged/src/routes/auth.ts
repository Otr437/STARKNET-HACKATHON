// src/routes/auth.ts — Authentication routes (PRODUCTION)
//
//  POST /auth/login           — email + password → access + refresh tokens
//  POST /auth/refresh         — rotate refresh token → new access token
//  POST /auth/logout          — revoke refresh token
//  GET  /auth/me              — current user info
//  POST /auth/change-password — change own password (requires current password)
//  POST /auth/mfa/setup       — generate TOTP secret (returns QR URI)
//  POST /auth/mfa/verify      — verify TOTP code + enable MFA
//  POST /auth/mfa/disable     — disable MFA (requires current password)

import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { authenticator } from "otplib";
import { prisma } from "../config/prisma";
import {
  verifyPassword,
  hashPassword,
  hashToken,
  generateSecureToken,
} from "../utils/crypto";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { authRateLimit, getIp } from "../middleware/security";
import { logger } from "../utils/logger";

const router = Router();

const ACCESS_TOKEN_TTL      = "15m";
const REFRESH_TOKEN_TTL_DAYS = 7;
const MAX_FAILED_LOGINS      = 5;
const LOCKOUT_MINUTES        = 30;

function issueAccessToken(userId: string, role: string): string {
  const secret = process.env.JWT_ACCESS_SECRET!;
  return jwt.sign({ sub: userId, role }, secret, { expiresIn: ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

// ── POST /auth/login ──────────────────────────────────────────
router.post("/login", authRateLimit, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    email:    z.string().email(),
    password: z.string().min(1).max(128),
    totpCode: z.string().length(6).optional(), // required if MFA enabled
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { email, password, totpCode } = parsed.data;
  const ip = getIp(req);

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    const invalid = () => res.status(401).json({ error: "Invalid credentials" });

    if (!user || !user.active) { invalid(); return; }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      res.status(429).json({ error: `Account locked until ${user.lockedUntil.toISOString()}` });
      return;
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      const newFailed = user.failedLogins + 1;
      const shouldLock = newFailed >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: newFailed,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      await prisma.auditLog.create({
        data: {
          userId: user.id, action: "USER_LOGIN_FAILED",
          resource: `User:${user.id}`, ipAddress: ip,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: { reason: "bad_password", failedAttempts: newFailed },
          success: false, errorMsg: "Invalid password",
        },
      });
      invalid(); return;
    }

    // MFA check — required if enabled
    if (user.mfaEnabled) {
      if (!totpCode) {
        res.status(200).json({ mfaRequired: true });
        return;
      }
      if (!user.mfaSecret || !authenticator.verify({ token: totpCode, secret: user.mfaSecret })) {
        res.status(401).json({ error: "Invalid MFA code" });
        return;
      }
    }

    const refreshRaw  = generateSecureToken();
    const refreshHash = hashToken(refreshRaw);
    const expiresAt   = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
      }),
      prisma.session.create({
        data: { userId: user.id, tokenHash: refreshHash, ipAddress: ip,
                userAgent: req.headers["user-agent"] ?? null, expiresAt },
      }),
      prisma.auditLog.create({
        data: { userId: user.id, action: "USER_LOGIN", resource: `User:${user.id}`,
                ipAddress: ip, userAgent: req.headers["user-agent"] ?? null,
                metadata: {}, success: true },
      }),
    ]);

    res.status(200).json({
      accessToken:  issueAccessToken(user.id, user.role),
      refreshToken: refreshRaw,
      expiresIn:    900,
      user: { id: user.id, email: user.email, role: user.role, mfaEnabled: user.mfaEnabled },
    });
  } catch (err: any) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────
router.post("/refresh", authRateLimit, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ refreshToken: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "refreshToken required" }); return; }

  const hash = hashToken(parsed.data.refreshToken);

  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.active) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    const newRefreshRaw  = generateSecureToken();
    const newRefreshHash = hashToken(newRefreshRaw);
    const newExpiresAt   = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const ip = getIp(req);

    await prisma.$transaction([
      prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
      prisma.session.create({
        data: { userId: session.userId, tokenHash: newRefreshHash,
                ipAddress: ip, userAgent: req.headers["user-agent"] ?? null, expiresAt: newExpiresAt },
      }),
    ]);

    res.status(200).json({
      accessToken:  issueAccessToken(session.user.id, session.user.role),
      refreshToken: newRefreshRaw,
      expiresIn:    900,
    });
  } catch (err: any) {
    logger.error(`Refresh error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const hash = hashToken(String(refreshToken));
    await prisma.session
      .updateMany({ where: { tokenHash: hash, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => {});
  }
  res.status(200).json({ message: "Logged out" });
});

// ── GET /auth/me ──────────────────────────────────────────────
router.get("/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = (req as AuthenticatedRequest).user;
  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, username: true, role: true,
                mfaEnabled: true, lastLoginAt: true, createdAt: true },
    });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.status(200).json(user);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/change-password ────────────────────────────────
router.post("/change-password", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string()
      .min(12)
      .regex(/[A-Z]/, "Must contain uppercase")
      .regex(/[a-z]/, "Must contain lowercase")
      .regex(/[0-9]/, "Must contain number")
      .regex(/[^A-Za-z0-9]/, "Must contain special char"),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { id } = (req as AuthenticatedRequest).user;
  const { currentPassword, newPassword } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) { res.status(401).json({ error: "Current password is incorrect" }); return; }

    const newHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { passwordHash: newHash } }),
      // Revoke all existing sessions to force re-login everywhere
      prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data:  { revokedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: { userId: id, action: "PASSWORD_CHANGED", resource: `User:${id}`,
                ipAddress: getIp(req), userAgent: req.headers["user-agent"] ?? null,
                metadata: {}, success: true },
      }),
    ]);

    res.json({ message: "Password changed. All sessions have been revoked. Please log in again." });
  } catch (err: any) {
    logger.error(`change-password error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/mfa/setup ──────────────────────────────────────
router.post("/mfa/setup", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id, email } = (req as AuthenticatedRequest).user;
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (user.mfaEnabled) { res.status(409).json({ error: "MFA already enabled" }); return; }

    const secret  = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(email, "RWA Oracle", secret);

    // Store secret temporarily — not enabled until verified
    await prisma.user.update({ where: { id }, data: { mfaSecret: secret } });

    res.json({
      secret,
      otpauthUrl: otpauth,
      message: "Scan the QR code with your authenticator app, then POST /auth/mfa/verify with a valid code.",
    });
  } catch (err: any) {
    logger.error(`MFA setup error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/mfa/verify ─────────────────────────────────────
router.post("/mfa/verify", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ totpCode: z.string().length(6) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "totpCode must be 6 digits" }); return; }

  const { id } = (req as AuthenticatedRequest).user;
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || !user.mfaSecret) {
      res.status(400).json({ error: "MFA setup not initiated. Call /auth/mfa/setup first." });
      return;
    }
    if (user.mfaEnabled) { res.status(409).json({ error: "MFA already enabled" }); return; }

    const valid = authenticator.verify({ token: parsed.data.totpCode, secret: user.mfaSecret });
    if (!valid) { res.status(401).json({ error: "Invalid TOTP code" }); return; }

    await prisma.user.update({ where: { id }, data: { mfaEnabled: true } });
    await prisma.auditLog.create({
      data: { userId: id, action: "MFA_ENABLED", resource: `User:${id}`,
              ipAddress: getIp(req), userAgent: req.headers["user-agent"] ?? null,
              metadata: {}, success: true },
    });

    res.json({ message: "MFA enabled successfully." });
  } catch (err: any) {
    logger.error(`MFA verify error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/mfa/disable ────────────────────────────────────
router.post("/mfa/disable", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "password required" }); return; }

  const { id } = (req as AuthenticatedRequest).user;
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (!user.mfaEnabled) { res.status(400).json({ error: "MFA is not enabled" }); return; }

    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) { res.status(401).json({ error: "Incorrect password" }); return; }

    await prisma.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecret: null } });
    await prisma.auditLog.create({
      data: { userId: id, action: "MFA_DISABLED", resource: `User:${id}`,
              ipAddress: getIp(req), userAgent: req.headers["user-agent"] ?? null,
              metadata: {}, success: true },
    });

    res.json({ message: "MFA disabled." });
  } catch (err: any) {
    logger.error(`MFA disable error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
