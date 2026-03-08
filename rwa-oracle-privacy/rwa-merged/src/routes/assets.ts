// src/admin/routes/assets.ts
// ─────────────────────────────────────────────────────────────
//  Asset management routes
//
//  GET    /assets            — list all assets
//  GET    /assets/:assetId   — single asset detail
//  POST   /assets            — register new asset (ADMIN+)
//  PATCH  /assets/:assetId   — update description (ADMIN+)
//  DELETE /assets/:assetId   — deactivate asset (ADMIN+)
// ─────────────────────────────────────────────────────────────

import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();
router.use(requireAuth);

// ── GET /assets ───────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  try {
    const assets = await prisma.asset.findMany({
      orderBy: [{ assetType: "asc" }, { symbol: "asc" }],
      include: {
        _count: { select: { priceHistory: true, priceFeeds: true } },
        priceHistory: {
          orderBy: { submittedAt: "desc" },
          take: 1,
          select: { medianPrice: true, submittedAt: true, status: true, txHash: true },
        },
      },
    });
    res.json(assets);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /assets/:assetId ──────────────────────────────────────
router.get("/:assetId", async (req: Request, res: Response): Promise<void> => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { assetId: req.params.assetId },
      include: {
        alertRules: true,
        priceHistory: {
          orderBy: { submittedAt: "desc" },
          take: 24,
          select: {
            id: true, medianPrice: true, sourceCount: true,
            sources: true, timestamp: true, txHash: true,
            blockNumber: true, submittedAt: true, status: true,
          },
        },
      },
    });
    if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json(asset);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /assets ──────────────────────────────────────────────
const AssetSchema = z.object({
  assetId:    z.string().min(1).max(31),  // Cairo felt252 short string limit
  symbol:     z.string().min(1).max(10),
  decimals:   z.number().int().min(0).max(18),
  assetType:  z.enum(["COMMODITY", "MACRO", "REAL_ESTATE", "EQUITY", "OTHER"]),
  description: z.string().max(500).optional(),
});

router.post("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = AssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const user = (req as AuthenticatedRequest).user;

  try {
    const existing = await prisma.asset.findUnique({ where: { assetId: parsed.data.assetId } });
    if (existing) {
      res.status(409).json({ error: "Asset already registered" });
      return;
    }

    const asset = await prisma.asset.create({
      data: { ...parsed.data },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "ASSET_REGISTERED",
        resource: `Asset:${asset.assetId}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: parsed.data,
        success: true,
      },
    });

    res.status(201).json(asset);
  } catch (err: any) {
    logger.error(`POST /assets error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /assets/:assetId ────────────────────────────────────
const UpdateAssetSchema = z.object({
  description:   z.string().max(500).optional(),
  onChainTxHash: z.string().optional(),
  registeredAt:  z.string().datetime().optional(),
});

router.patch("/:assetId", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = UpdateAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  try {
    const asset = await prisma.asset.update({
      where: { assetId: req.params.assetId },
      data: {
        ...parsed.data,
        ...(parsed.data.registeredAt ? { registeredAt: new Date(parsed.data.registeredAt) } : {}),
      },
    });
    res.json(asset);
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "Asset not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /assets/:assetId ───────────────────────────────────
router.delete("/:assetId", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user;

  try {
    const asset = await prisma.asset.update({
      where: { assetId: req.params.assetId },
      data: { active: false },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "ASSET_DEACTIVATED",
        resource: `Asset:${asset.assetId}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: {},
        success: true,
      },
    });

    res.json({ message: `Asset ${asset.assetId} deactivated` });
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "Asset not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
