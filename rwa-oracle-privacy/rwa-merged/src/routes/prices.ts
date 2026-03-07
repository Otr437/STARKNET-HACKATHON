// src/routes/prices.ts — Price data routes (PRODUCTION)
//
//  GET  /prices                 — latest price per asset (single optimized query)
//  GET  /prices/:assetId        — price history with pagination + date filters
//  GET  /prices/:assetId/feeds  — raw per-source readings
//  POST /prices/record          — feeder: write confirmed price (ApiKey)
//  POST /prices/feeds           — feeder: write raw source readings (ApiKey)

import { Router, Request, Response } from "express";
import { z } from "zod";
import { SubmitStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth, requireApiKey, requireScope } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();

// ── GET /prices — latest price per asset ─────────────────────
// Single query with subquery — no N+1
router.get(
  "/",
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const assets = await prisma.asset.findMany({
        where: { active: true },
        orderBy: [{ assetType: "asc" }, { symbol: "asc" }],
        select: {
          assetId: true,
          symbol:  true,
          decimals: true,
          assetType: true,
          description: true,
          priceHistory: {
            where:   { status: "CONFIRMED" },
            orderBy: { submittedAt: "desc" },
            take: 1,
            select: {
              medianPrice:  true,
              timestamp:    true,
              submittedAt:  true,
              sourceCount:  true,
              txHash:       true,
              blockNumber:  true,
            },
          },
        },
      });

      const result = assets.map((a) => ({
        assetId:     a.assetId,
        symbol:      a.symbol,
        decimals:    a.decimals,
        assetType:   a.assetType,
        description: a.description,
        latest:      a.priceHistory[0] ?? null,
      }));

      res.json(result);
    } catch (err: any) {
      logger.error(`GET /prices error: ${err.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ── GET /prices/:assetId — price history ──────────────────────
router.get(
  "/:assetId",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const page  = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(500, parseInt(req.query.limit as string) || 100);
      const from  = req.query.from ? new Date(req.query.from as string) : undefined;
      const to    = req.query.to   ? new Date(req.query.to   as string) : undefined;
      const status = req.query.status as SubmitStatus | undefined;

      if (from && isNaN(from.getTime())) {
        res.status(400).json({ error: "Invalid 'from' date" });
        return;
      }
      if (to && isNaN(to.getTime())) {
        res.status(400).json({ error: "Invalid 'to' date" });
        return;
      }

      const where = {
        assetId: req.params.assetId,
        ...(status ? { status } : {}),
        ...(from || to
          ? { timestamp: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      };

      const [records, total] = await prisma.$transaction([
        prisma.priceHistory.findMany({
          where,
          orderBy: { timestamp: "desc" },
          skip:    (page - 1) * limit,
          take:    limit,
        }),
        prisma.priceHistory.count({ where }),
      ]);

      res.json({ records, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (err: any) {
      logger.error(`GET /prices/:assetId error: ${err.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ── GET /prices/:assetId/feeds — raw source readings ──────────
router.get(
  "/:assetId/feeds",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit  = Math.min(200, parseInt(req.query.limit as string) || 50);
      const source = req.query.source as string | undefined;

      const feeds = await prisma.priceFeed.findMany({
        where: {
          assetId: req.params.assetId,
          ...(source ? { source } : {}),
        },
        orderBy: { fetchedAt: "desc" },
        take: limit,
      });

      res.json(feeds);
    } catch (err: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ── POST /prices/record — feeder writes confirmed price ───────
const RecordSchema = z.object({
  assetId:      z.string().min(1).max(31),
  medianPrice:  z.number().positive(),
  sourceCount:  z.number().int().min(1),
  sources:      z.array(z.string()).min(1),
  onChainPrice: z.string().regex(/^\d+$/, "Must be a positive integer string"),
  timestamp:    z.number().int().positive(),
  txHash:       z.string().optional(),
  blockNumber:  z.number().int().optional(),
  status:       z.nativeEnum(SubmitStatus).default("CONFIRMED"),
  errorMessage: z.string().optional(),
});

router.post(
  "/record",
  requireApiKey,
  requireScope("price:write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RecordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }

    const d = parsed.data;

    // Validate asset exists
    const asset = await prisma.asset.findUnique({ where: { assetId: d.assetId } });
    if (!asset) {
      res.status(404).json({ error: `Asset not found: ${d.assetId}` });
      return;
    }

    try {
      const record = await prisma.priceHistory.create({
        data: {
          assetId:      d.assetId,
          medianPrice:  d.medianPrice,
          sourceCount:  d.sourceCount,
          sources:      d.sources,
          onChainPrice: BigInt(d.onChainPrice),
          timestamp:    new Date(d.timestamp * 1000),
          txHash:       d.txHash ?? null,
          blockNumber:  d.blockNumber ? BigInt(d.blockNumber) : null,
          status:       d.status,
          errorMessage: d.errorMessage ?? null,
        },
      });

      res.status(201).json({ id: record.id });
    } catch (err: any) {
      logger.error(`POST /prices/record error: ${err.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ── POST /prices/feeds — feeder writes raw source readings ────
const FeedBatchSchema = z.object({
  feeds: z.array(
    z.object({
      assetId:   z.string().min(1).max(31),
      source:    z.string().min(1).max(32),
      price:     z.number().positive(),
      timestamp: z.number().int().positive(),
    })
  ).min(1).max(100),
});

router.post(
  "/feeds",
  requireApiKey,
  requireScope("price:write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = FeedBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }

    try {
      const result = await prisma.priceFeed.createMany({
        data: parsed.data.feeds.map((f) => ({
          assetId:   f.assetId,
          source:    f.source,
          price:     f.price,
          timestamp: new Date(f.timestamp * 1000),
        })),
        skipDuplicates: true,
      });

      res.status(201).json({ created: result.count });
    } catch (err: any) {
      logger.error(`POST /prices/feeds error: ${err.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
