// src/utils/healthMonitor.ts — Health Monitor (PRODUCTION)
// State is stored in module-level variables so both the feeder
// and server can read it within the SAME process.
// When running as separate processes, the /api/health endpoint
// queries the DB directly for ground truth.

import { prisma } from "../config/prisma";
import { OracleSubmitter } from "../services/submitter";
import { logger } from "./logger";

export interface HealthStatus {
  healthy: boolean;
  db:       { status: "ok" | "error"; latencyMs?: number; error?: string };
  starknet: { status: "ok" | "error"; chainId?: string; error?: string };
  feeder: {
    lastCycleAt:   string | null;
    assetsTracked: number;
    uptime:        number;
  };
  checkedAt: string;
}

// Module-level state — readable within the same process
let _lastCycleAt: string | null = null;
let _currentHealth: HealthStatus = {
  healthy:  false,
  db:       { status: "error" },
  starknet: { status: "error" },
  feeder:   { lastCycleAt: null, assetsTracked: 0, uptime: 0 },
  checkedAt: new Date().toISOString(),
};

export function updateLastCycleAt(): void {
  _lastCycleAt = new Date().toISOString();
}

export function getCurrentHealth(): HealthStatus {
  return _currentHealth;
}

export class HealthMonitor {
  private submitter: OracleSubmitter;

  constructor(submitter: OracleSubmitter) {
    this.submitter = submitter;
  }

  async runChecks(): Promise<HealthStatus> {
    const [db, starknet] = await Promise.all([
      this.checkDb(),
      this.checkStarknet(),
    ]);

    const assetCount = await prisma.asset.count({ where: { active: true } }).catch(() => 0);

    _currentHealth = {
      healthy: db.status === "ok" && starknet.status === "ok",
      db,
      starknet,
      feeder: {
        lastCycleAt:   _lastCycleAt,
        assetsTracked: assetCount,
        uptime:        process.uptime(),
      },
      checkedAt: new Date().toISOString(),
    };

    if (!_currentHealth.healthy) {
      logger.warn("Health check FAILED", { db: db.status, starknet: starknet.status });
    } else {
      logger.debug("Health check passed");
    }

    return _currentHealth;
  }

  private async checkDb(): Promise<HealthStatus["db"]> {
    const start = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: "error", error: err.message };
    }
  }

  private async checkStarknet(): Promise<HealthStatus["starknet"]> {
    try {
      const ok = await this.submitter.checkConnection();
      if (!ok) return { status: "error", error: "RPC unreachable" };
      return { status: "ok" };
    } catch (err: any) {
      return { status: "error", error: err.message };
    }
  }
}
