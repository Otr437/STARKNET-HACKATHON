// src/admin/routes/users.ts
// ─────────────────────────────────────────────────────────────
//  User management routes (SUPER_ADMIN / ADMIN only)
//
//  GET    /users          — list users (ADMIN+)
//  GET    /users/:id      — get single user (ADMIN+)
//  POST   /users          — create user (SUPER_ADMIN)
//  PATCH  /users/:id      — update role / active (SUPER_ADMIN)
//  DELETE /users/:id      — deactivate user (SUPER_ADMIN)
//  GET    /users/:id/audit— audit log for user (ADMIN+)
// ─────────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../config/prisma";
import { hashPassword } from "../utils/crypto";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();

// All user routes require auth
router.use(requireAuth);

// ── GET /users ────────────────────────────────────────────────
router.get("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true, email: true, username: true, role: true,
          active: true, lastLoginAt: true, createdAt: true,
          mfaEnabled: true, failedLogins: true, lockedUntil: true,
        },
      }),
      prisma.user.count(),
    ]);

    res.json({ users, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    logger.error(`GET /users error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /users/:id ────────────────────────────────────────────
router.get("/:id", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, email: true, username: true, role: true,
        active: true, lastLoginAt: true, lastLoginIp: true,
        mfaEnabled: true, failedLogins: true, lockedUntil: true,
        createdAt: true, updatedAt: true,
      },
    });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /users ───────────────────────────────────────────────
const CreateUserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: z
    .string()
    .min(12)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(/[^A-Za-z0-9]/, "Must contain special char"),
  role: z.nativeEnum(Role).default("VIEWER"),
});

router.post("/", requireRole("SUPER_ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { email, username, password, role } = parsed.data;

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      res.status(409).json({ error: "Email or username already taken" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, username, passwordHash, role },
      select: { id: true, email: true, username: true, role: true, createdAt: true },
    });

    const creator = (req as AuthenticatedRequest).user;
    await prisma.auditLog.create({
      data: {
        userId: creator.id,
        action: "USER_CREATED",
        resource: `User:${user.id}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: { email, username, role },
        success: true,
      },
    });

    res.status(201).json(user);
  } catch (err: any) {
    logger.error(`POST /users error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /users/:id ──────────────────────────────────────────
const UpdateUserSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  active: z.boolean().optional(),
  unlockAccount: z.boolean().optional(), // reset failedLogins + lockedUntil
});

router.patch("/:id", requireRole("SUPER_ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { role, active, unlockAccount } = parsed.data;
  const requester = (req as AuthenticatedRequest).user;

  // Prevent demoting yourself
  if (req.params.id === requester.id && role !== undefined) {
    res.status(403).json({ error: "Cannot change your own role" });
    return;
  }

  try {
    const updateData: Record<string, unknown> = {};
    if (role !== undefined) updateData.role = role;
    if (active !== undefined) updateData.active = active;
    if (unlockAccount) {
      updateData.failedLogins = 0;
      updateData.lockedUntil = null;
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      select: { id: true, email: true, role: true, active: true, updatedAt: true },
    });

    await prisma.auditLog.create({
      data: {
        userId: requester.id,
        action: "USER_UPDATED",
        resource: `User:${user.id}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: updateData,
        success: true,
      },
    });

    res.json(user);
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "User not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /users/:id — soft delete (deactivate) ──────────────
router.delete("/:id", requireRole("SUPER_ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const requester = (req as AuthenticatedRequest).user;
  if (req.params.id === requester.id) {
    res.status(403).json({ error: "Cannot deactivate your own account" });
    return;
  }

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.params.id },
        data: { active: false },
      }),
      // Revoke all active sessions
      prisma.session.updateMany({
        where: { userId: req.params.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          userId: requester.id,
          action: "USER_DEACTIVATED",
          resource: `User:${req.params.id}`,
          ipAddress: req.socket?.remoteAddress ?? null,
          metadata: {},
          success: true,
        },
      }),
    ]);

    res.json({ message: "User deactivated and all sessions revoked" });
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "User not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /users/:id/audit ──────────────────────────────────────
router.get("/:id/audit", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where: { userId: req.params.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where: { userId: req.params.id } }),
    ]);

    res.json({ logs, total, page, limit });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
