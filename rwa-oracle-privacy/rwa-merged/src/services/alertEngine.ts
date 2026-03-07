// src/services/alertEngine.ts
// ─────────────────────────────────────────────────────────────
//  Alert Engine (PRODUCTION)
//  Loads AlertRules from DB and fires real webhook + email
//  notifications when thresholds are breached.
//
//  Alert types:
//    PRICE_STALE       — no confirmed update in N seconds
//    DEVIATION_HIGH    — spread between sources > N%
//    SOURCE_DOWN       — a configured source returned no data
//    SUBMISSION_FAILED — on-chain tx failed
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import { prisma } from "../config/prisma";
import { AggregatedPrice } from "../types";
import { logger } from "../utils/logger";

const KNOWN_SOURCES = ["goldapi", "metalpriceapi", "metalsdev", "alphavantage"];

export class AlertEngine {
  /**
   * Fire SOURCE_DOWN alerts for any source that returned no data this cycle.
   */
  async checkSourceHealth(activeSources: string[]): Promise<void> {
    const downSources = KNOWN_SOURCES.filter((s) => !activeSources.includes(s));
    if (downSources.length === 0) return;

    logger.warn(`Sources down this cycle: ${downSources.join(", ")}`);

    try {
      const rules = await prisma.alertRule.findMany({
        where: { type: "SOURCE_DOWN", active: true },
        include: { asset: true },
      });

      for (const rule of rules) {
        await this.fire(rule, {
          type: "SOURCE_DOWN",
          message: `Price sources down: ${downSources.join(", ")}`,
          downSources,
          assetId: rule.assetId,
        });
      }
    } catch (err: any) {
      logger.warn(`AlertEngine SOURCE_DOWN check failed: ${err.message}`);
    }
  }

  /**
   * Check DEVIATION_HIGH alerts for each aggregated asset.
   */
  async checkDeviationAlerts(aggregated: AggregatedPrice[]): Promise<void> {
    try {
      const rules = await prisma.alertRule.findMany({
        where: { type: "DEVIATION_HIGH", active: true },
      });

      for (const agg of aggregated) {
        const rule = rules.find((r) => r.assetId === agg.assetId);
        if (!rule) continue;

        const prices = agg.sources.map((s) => s.price);
        if (prices.length < 2) continue;

        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const spreadPct = ((max - min) / agg.medianPrice) * 100;

        if (spreadPct > Number(rule.threshold)) {
          logger.warn(`DEVIATION ALERT: ${agg.assetId} spread ${spreadPct.toFixed(2)}% > ${rule.threshold}%`);
          await this.fire(rule, {
            type: "DEVIATION_HIGH",
            assetId: agg.assetId,
            message: `Price deviation ${spreadPct.toFixed(2)}% exceeds threshold ${rule.threshold}%`,
            spreadPct,
            medianPrice: agg.medianPrice,
            sourcePrices: Object.fromEntries(agg.sources.map((s) => [s.source, s.price])),
          });
        }
      }
    } catch (err: any) {
      logger.warn(`AlertEngine DEVIATION check failed: ${err.message}`);
    }
  }

  /**
   * Check PRICE_STALE alerts — called externally or on a schedule.
   */
  async checkStalenessAlerts(): Promise<void> {
    try {
      const rules = await prisma.alertRule.findMany({
        where: { type: "PRICE_STALE", active: true },
        include: { asset: true },
      });

      const now = new Date();

      for (const rule of rules) {
        const latest = await prisma.priceHistory.findFirst({
          where: { assetId: rule.assetId, status: "CONFIRMED" },
          orderBy: { submittedAt: "desc" },
        });

        if (!latest) continue;

        const ageSeconds = (now.getTime() - latest.submittedAt.getTime()) / 1000;
        if (ageSeconds > Number(rule.threshold)) {
          logger.warn(`STALE ALERT: ${rule.assetId} — last update ${Math.round(ageSeconds)}s ago`);
          await this.fire(rule, {
            type: "PRICE_STALE",
            assetId: rule.assetId,
            message: `Price for ${rule.assetId} is stale — last updated ${Math.round(ageSeconds / 60)} minutes ago`,
            ageSeconds,
            lastUpdate: latest.submittedAt.toISOString(),
          });
        }
      }
    } catch (err: any) {
      logger.warn(`AlertEngine STALE check failed: ${err.message}`);
    }
  }

  /**
   * Fire SUBMISSION_FAILED alert for a specific asset.
   */
  async fireSubmissionFailedAlert(assetId: string, error: string): Promise<void> {
    try {
      const rules = await prisma.alertRule.findMany({
        where: { type: "SUBMISSION_FAILED", assetId, active: true },
      });

      for (const rule of rules) {
        await this.fire(rule, {
          type: "SUBMISSION_FAILED",
          assetId,
          message: `On-chain submission failed for ${assetId}: ${error}`,
          error,
        });
      }
    } catch (err: any) {
      logger.warn(`AlertEngine SUBMISSION_FAILED fire failed: ${err.message}`);
    }
  }

  /**
   * Fire an alert rule — sends webhook and/or emails.
   */
  private async fire(rule: any, payload: Record<string, unknown>): Promise<void> {
    const enriched = {
      ...payload,
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV ?? "production",
    };

    // Fire webhook
    if (rule.webhookUrl) {
      try {
        await axios.post(rule.webhookUrl, enriched, {
          timeout: 10_000,
          headers: {
            "Content-Type": "application/json",
            "User-Agent":   "rwa-oracle-feeder/1.0",
          },
        });
        logger.info(`Alert webhook fired: ${rule.type} → ${rule.webhookUrl}`);
      } catch (err: any) {
        logger.error(`Alert webhook failed (${rule.webhookUrl}): ${err.message}`);
      }
    }

    // Send email alerts via configured SMTP
    if (rule.emailRecipients?.length > 0) {
      await this.sendEmailAlert(rule.emailRecipients, rule.type, enriched);
    }

    // Update lastTriggeredAt
    await prisma.alertRule
      .update({ where: { id: rule.id }, data: { lastTriggeredAt: new Date() } })
      .catch(() => {});
  }

  /**
   * Send email alert via SMTP (uses nodemailer or SMTP relay env vars).
   * Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env
   */
  private async sendEmailAlert(
    recipients: string[],
    alertType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) {
      logger.debug("SMTP not configured — skipping email alert");
      return;
    }

    try {
      // Dynamic import to avoid loading nodemailer when SMTP not configured
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT ?? "587"),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transport.sendMail({
        from:    process.env.SMTP_FROM ?? "rwa-oracle@noreply.local",
        to:      recipients.join(", "),
        subject: `[RWA Oracle Alert] ${alertType}`,
        text:    JSON.stringify(payload, null, 2),
        html:    `<pre>${JSON.stringify(payload, null, 2)}</pre>`,
      });

      logger.info(`Email alert sent: ${alertType} → ${recipients.join(", ")}`);
    } catch (err: any) {
      logger.error(`Email alert failed: ${err.message}`);
    }
  }

  async fireSourceDownAlerts(activeSources: string[]): Promise<void> {
    return this.checkSourceHealth(activeSources);
  }
}
