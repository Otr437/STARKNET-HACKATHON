// src/server.ts — RWA Oracle Admin API Server (PRODUCTION)

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { prisma } from "./config/prisma";
import { logger } from "./utils/logger";
import {
  httpsRedirect, helmetMiddleware, globalRateLimit,
  sanitizeBody, auditMiddleware,
} from "./middleware/security";
import { requireAuth, requireRole } from "./middleware/auth";

import authRoutes    from "./routes/auth";
import usersRoutes   from "./routes/users";
import apikeysRoutes from "./routes/apikeys";
import assetsRoutes  from "./routes/assets";
import pricesRoutes  from "./routes/prices";
import alertsRoutes  from "./routes/alerts";

export function createAdminServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(httpsRedirect);
  app.use(helmetMiddleware);
  app.use(globalRateLimit);

  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",").map((o) => o.trim()).filter(Boolean);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || process.env.NODE_ENV !== "production") { callback(null, true); return; }
      if (allowedOrigins.includes(origin)) { callback(null, true); }
      else { callback(new Error(`CORS: origin ${origin} not allowed`)); }
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(sanitizeBody);
  app.use(auditMiddleware);

  app.use("/api/auth",    authRoutes);
  app.use("/api/users",   usersRoutes);
  app.use("/api/apikeys", apikeysRoutes);
  app.use("/api/assets",  assetsRoutes);
  app.use("/api/prices",  pricesRoutes);
  app.use("/api/alerts",  alertsRoutes);

  // ── Health check — queries DB directly (works cross-process) ──
  app.get("/api/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      const start = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      const dbLatencyMs = Date.now() - start;

      // Get latest price submission to show feeder activity
      const latestSubmission = await prisma.priceHistory.findFirst({
        orderBy: { submittedAt: "desc" },
        select: { submittedAt: true, status: true },
      }).catch(() => null);

      const assetCount = await prisma.asset.count({ where: { active: true } }).catch(() => 0);

      res.json({
        status:    "ok",
        db:        { status: "connected", latencyMs: dbLatencyMs },
        feeder: {
          lastSubmissionAt: latestSubmission?.submittedAt ?? null,
          lastSubmissionStatus: latestSubmission?.status ?? null,
          assetsTracked: assetCount,
        },
        uptime:    process.uptime(),
        version:   process.env.npm_package_version ?? "2.0.0",
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({ status: "error", db: "disconnected", error: err.message });
    }
  });

  // ── Audit log (ADMIN+) ────────────────────────────────────────
  app.get("/api/audit", requireAuth, requireRole("ADMIN"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page   = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit  = Math.min(200, parseInt(req.query.limit as string) || 50);
        const action = req.query.action as string | undefined;
        const userId = req.query.userId as string | undefined;
        const from   = req.query.from ? new Date(req.query.from as string) : undefined;
        const to     = req.query.to   ? new Date(req.query.to   as string) : undefined;

        const where = {
          ...(action ? { action } : {}),
          ...(userId ? { userId } : {}),
          ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        };

        const [logs, total] = await prisma.$transaction([
          prisma.auditLog.findMany({
            where, orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit, take: limit,
            include: { user: { select: { email: true, username: true } } },
          }),
          prisma.auditLog.count({ where }),
        ]);

        res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
      } catch (err: any) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: "Route not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    res.status(500).json({
      error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    });
  });

  return app;
}

export async function startAdminServer(): Promise<void> {
  const app  = createAdminServer();
  const port = parseInt(process.env.ADMIN_PORT ?? "4000", 10);

  const server = app.listen(port, () => {
    logger.info(`Admin API server listening on port ${port}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} — shutting down admin server`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info("Admin server shut down cleanly");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

if (require.main === module) {
  startAdminServer().catch((err) => {
    logger.error("Fatal error starting admin server:", err);
    process.exit(1);
  });
}
