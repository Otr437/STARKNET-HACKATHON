// src/admin/routes/apikeys.ts
// ─────────────────────────────────────────────────────────────
//  API Key management
//
//  GET    /apikeys          — list your keys (ADMIN: list all)
//  POST   /apikeys          — create a new key (ADMIN+)
//  DELETE /apikeys/:id      — revoke a key (ADMIN+)
// ─────────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { generateApiKey } from "../utils/crypto";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();
router.use(requireAuth);

const VALID_SCOPES = ["price:write", "price:read", "asset:read", "asset:write"];

// ── GET /apikeys ──────────────────────────────────────────────
router.get("/", async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user;
  const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(user.role);

  try {
    const keys = await prisma.apiKey.findMany({
      where: isAdmin ? {} : { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, keyPrefix: true, scopes: true,
        active: true, lastUsedAt: true, expiresAt: true,
        revokedAt: true, createdAt: true,
        user: { select: { id: true, email: true } },
      },
    });
    res.json(keys);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /apikeys ─────────────────────────────────────────────
const CreateKeySchema = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.enum(VALID_SCOPES as [string, ...string[]])).min(1),
  expiresInDays: z.number().int().min(1).max(365).optional(), // null = never
});

router.post("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { name, scopes, expiresInDays } = parsed.data;
  const user = (req as AuthenticatedRequest).user;

  try {
    const { raw, prefix, hash } = generateApiKey();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;

    const key = await prisma.apiKey.create({
      data: {
        name,
        keyHash: hash,
        keyPrefix: prefix,
        userId: user.id,
        scopes,
        expiresAt,
      },
      select: {
        id: true, name: true, keyPrefix: true,
        scopes: true, expiresAt: true, createdAt: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "API_KEY_CREATED",
        resource: `ApiKey:${key.id}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: { name, scopes, expiresAt },
        success: true,
      },
    });

    // Return raw key ONCE — it will never be shown again
    res.status(201).json({
      ...key,
      key: raw, // raw key returned ONLY at creation time
      warning: "Store this key securely. It will not be shown again.",
    });
  } catch (err: any) {
    logger.error(`POST /apikeys error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /apikeys/:id ───────────────────────────────────────
router.delete("/:id", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user;

  try {
    const existing = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "API key not found" }); return; }

    // Non-super-admin can only revoke their own keys
    if (!["SUPER_ADMIN"].includes(user.role) && existing.userId !== user.id) {
      res.status(403).json({ error: "Cannot revoke another user's API key" });
      return;
    }

    await prisma.$transaction([
      prisma.apiKey.update({
        where: { id: req.params.id },
        data: { active: false, revokedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "API_KEY_REVOKED",
          resource: `ApiKey:${req.params.id}`,
          ipAddress: req.socket?.remoteAddress ?? null,
          metadata: { name: existing.name },
          success: true,
        },
      }),
    ]);

    res.json({ message: "API key revoked" });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
