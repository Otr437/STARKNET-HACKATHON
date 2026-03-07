// src/routes/alerts.ts — Alert rule management (PRODUCTION)
//
//  GET    /alerts              — list all alert rules (ADMIN+)
//  GET    /alerts/:id          — single rule detail
//  POST   /alerts              — create alert rule (ADMIN+)
//  PATCH  /alerts/:id          — update rule (ADMIN+)
//  DELETE /alerts/:id          — delete rule (ADMIN+)
//  POST   /alerts/:id/test     — send a test notification (ADMIN+)

import { Router, Request, Response } from "express";
import { z } from "zod";
import { AlertType } from "@prisma/client";
import axios from "axios";
import { prisma } from "../config/prisma";
import { requireAuth, requireRole, AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();
router.use(requireAuth);

const AlertRuleSchema = z.object({
  assetId:          z.string().min(1).max(31),
  type:             z.nativeEnum(AlertType),
  // PRICE_STALE: seconds (e.g. 3600 = 1hr)
  // DEVIATION_HIGH: percent (e.g. 5.0 = 5%)
  // SOURCE_DOWN: any (threshold unused, set to 0)
  // SUBMISSION_FAILED: any (threshold unused, set to 0)
  threshold:        z.number().min(0),
  webhookUrl:       z.string().url().optional().or(z.literal("")),
  emailRecipients:  z.array(z.string().email()).default([]),
  active:           z.boolean().default(true),
});

// ── GET /alerts ───────────────────────────────────────────────
router.get("/", requireRole("ADMIN"), async (_req: Request, res: Response): Promise<void> => {
  try {
    const rules = await prisma.alertRule.findMany({
      orderBy: [{ assetId: "asc" }, { type: "asc" }],
      include: { asset: { select: { symbol: true, assetType: true } } },
    });
    res.json(rules);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /alerts/:id ───────────────────────────────────────────
router.get("/:id", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const rule = await prisma.alertRule.findUnique({
      where: { id: req.params.id },
      include: { asset: true },
    });
    if (!rule) { res.status(404).json({ error: "Alert rule not found" }); return; }
    res.json(rule);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /alerts ──────────────────────────────────────────────
router.post("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = AlertRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const user = (req as AuthenticatedRequest).user;
  const data = parsed.data;

  try {
    const asset = await prisma.asset.findUnique({ where: { assetId: data.assetId } });
    if (!asset) {
      res.status(404).json({ error: `Asset not found: ${data.assetId}` });
      return;
    }

    const rule = await prisma.alertRule.create({
      data: {
        assetId:         data.assetId,
        type:            data.type,
        threshold:       data.threshold,
        webhookUrl:      data.webhookUrl || null,
        emailRecipients: data.emailRecipients,
        active:          data.active,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id, action: "ALERT_RULE_CREATED",
        resource: `AlertRule:${rule.id}`,
        ipAddress: req.socket?.remoteAddress ?? null,
        metadata: data, success: true,
      },
    });

    res.status(201).json(rule);
  } catch (err: any) {
    logger.error(`POST /alerts error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /alerts/:id ─────────────────────────────────────────
router.patch("/:id", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const parsed = AlertRuleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  try {
    const rule = await prisma.alertRule.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        webhookUrl: parsed.data.webhookUrl === "" ? null : parsed.data.webhookUrl,
      },
    });
    res.json(rule);
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "Alert rule not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /alerts/:id ────────────────────────────────────────
router.delete("/:id", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user;
  try {
    await prisma.$transaction([
      prisma.alertRule.delete({ where: { id: req.params.id } }),
      prisma.auditLog.create({
        data: {
          userId: user.id, action: "ALERT_RULE_DELETED",
          resource: `AlertRule:${req.params.id}`,
          ipAddress: req.socket?.remoteAddress ?? null,
          metadata: {}, success: true,
        },
      }),
    ]);
    res.json({ message: "Alert rule deleted" });
  } catch (err: any) {
    if (err.code === "P2025") { res.status(404).json({ error: "Alert rule not found" }); return; }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /alerts/:id/test ─────────────────────────────────────
router.post("/:id/test", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const rule = await prisma.alertRule.findUnique({ where: { id: req.params.id } });
    if (!rule) { res.status(404).json({ error: "Alert rule not found" }); return; }

    const testPayload = {
      type:      rule.type,
      assetId:   rule.assetId,
      message:   `TEST: This is a test alert for rule ${rule.id}`,
      threshold: rule.threshold,
      timestamp: new Date().toISOString(),
      test:      true,
    };

    const results: { webhook?: string; email?: string } = {};

    if (rule.webhookUrl) {
      try {
        await axios.post(rule.webhookUrl, testPayload, { timeout: 10_000 });
        results.webhook = "sent";
      } catch (err: any) {
        results.webhook = `failed: ${err.message}`;
      }
    }

    if (rule.emailRecipients.length > 0) {
      const smtpHost = process.env.SMTP_HOST;
      if (smtpHost) {
        try {
          const nodemailer = await import("nodemailer");
          const transport = nodemailer.createTransport({
            host: smtpHost, port: parseInt(process.env.SMTP_PORT ?? "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          });
          await transport.sendMail({
            from:    process.env.SMTP_FROM ?? "rwa-oracle@noreply.local",
            to:      rule.emailRecipients.join(", "),
            subject: `[RWA Oracle TEST] ${rule.type}`,
            text:    JSON.stringify(testPayload, null, 2),
          });
          results.email = "sent";
        } catch (err: any) {
          results.email = `failed: ${err.message}`;
        }
      } else {
        results.email = "skipped (SMTP not configured)";
      }
    }

    res.json({ message: "Test alert dispatched", results });
  } catch (err: any) {
    logger.error(`POST /alerts/:id/test error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
