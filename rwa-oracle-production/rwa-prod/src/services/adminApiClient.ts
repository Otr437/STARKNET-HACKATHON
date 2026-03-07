// src/services/adminApiClient.ts — Admin API Client (PRODUCTION)
// Authenticates with FEEDER_API_KEY (rwa_*** format).
// Falls back to JWT login if no API key set.
// Auto-refreshes JWT before expiry.
// Chunks raw feeds to respect the API's 100-item limit.
// Provides session cleanup for maintenance.

import axios, { AxiosInstance } from "axios";
import { SourcePrice, SubmitResult } from "../types";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";

const FEED_CHUNK_SIZE = 90; // stay under the API's max(100) limit
const JWT_REFRESH_BUFFER_MS = 2 * 60 * 1000; // refresh 2 min before expiry

export class AdminApiClient {
  private client: AxiosInstance;
  private useApiKey = false;
  private jwtExpiresAt = 0;
  private feederEmail: string | undefined;
  private feederPassword: string | undefined;

  constructor() {
    const baseURL = process.env.ADMIN_API_URL ?? "http://localhost:4000";
    this.client = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { "Content-Type": "application/json" },
    });
    this.feederEmail    = process.env.FEEDER_EMAIL;
    this.feederPassword = process.env.FEEDER_PASSWORD;
  }

  async authenticate(): Promise<void> {
    const apiKey = process.env.FEEDER_API_KEY;
    if (apiKey && apiKey.startsWith("rwa_")) {
      this.client.defaults.headers.common["Authorization"] = `ApiKey ${apiKey}`;
      this.useApiKey = true;
      logger.info("AdminApiClient: authenticated with API key");
      return;
    }

    if (!this.feederEmail || !this.feederPassword) {
      logger.warn("AdminApiClient: no FEEDER_API_KEY or credentials — DB persistence disabled");
      return;
    }

    await this.jwtLogin();
  }

  private async jwtLogin(): Promise<void> {
    try {
      const { data } = await this.client.post("/api/auth/login", {
        email:    this.feederEmail,
        password: this.feederPassword,
      });
      this.client.defaults.headers.common["Authorization"] = `Bearer ${data.accessToken}`;
      // expiresIn is in seconds; store expiry as ms timestamp
      this.jwtExpiresAt = Date.now() + (data.expiresIn ?? 900) * 1000;
      logger.info("AdminApiClient: authenticated via JWT");
    } catch (err: any) {
      logger.error(`AdminApiClient: JWT login failed: ${err.message}`);
    }
  }

  /** Ensure JWT is still valid; re-login if within buffer window */
  private async ensureAuth(): Promise<void> {
    if (this.useApiKey) return;
    if (!this.client.defaults.headers.common["Authorization"]) return;
    if (Date.now() < this.jwtExpiresAt - JWT_REFRESH_BUFFER_MS) return;
    logger.info("AdminApiClient: JWT expiring soon — refreshing");
    await this.jwtLogin();
  }

  private isAuthenticated(): boolean {
    return !!this.client.defaults.headers.common["Authorization"];
  }

  /** Persist raw per-source price readings — chunked to stay under API limits */
  async persistRawFeeds(prices: SourcePrice[]): Promise<void> {
    if (!this.isAuthenticated() || prices.length === 0) return;
    await this.ensureAuth();

    for (let i = 0; i < prices.length; i += FEED_CHUNK_SIZE) {
      const chunk = prices.slice(i, i + FEED_CHUNK_SIZE);
      try {
        await this.client.post("/api/prices/feeds", {
          feeds: chunk.map((p) => ({
            assetId:   p.assetId,
            source:    p.source,
            price:     p.price,
            timestamp: p.timestamp,
          })),
        });
      } catch (err: any) {
        logger.warn(`AdminApiClient: raw feed chunk ${i / FEED_CHUNK_SIZE + 1} failed: ${err.message}`);
      }
    }
    logger.debug(`Persisted ${prices.length} raw price feeds to DB`);
  }

  /** Persist aggregated on-chain price records */
  async persistPriceHistory(results: SubmitResult[]): Promise<void> {
    if (!this.isAuthenticated() || results.length === 0) return;
    await this.ensureAuth();

    const settled = await Promise.allSettled(
      results.map((r) =>
        this.client.post("/api/prices/record", {
          assetId:      r.assetId,
          medianPrice:  r.medianPrice,
          sourceCount:  r.sourceCount,
          sources:      r.sources,
          onChainPrice: r.onChainPrice,
          timestamp:    r.timestamp,
          txHash:       r.txHash,
          blockNumber:  r.blockNumber,
          status:       r.status,
          errorMessage: r.errorMessage,
        })
      )
    );

    const failed = settled.filter((s) => s.status === "rejected").length;
    if (failed > 0) logger.warn(`AdminApiClient: ${failed}/${results.length} price history records failed to persist`);
    else logger.info(`Price history persisted: ${results.length} records`);
  }

  /**
   * Delete expired/revoked sessions older than 30 days.
   * Called by the session cleanup cron in index.ts.
   */
  async cleanupExpiredSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    try {
      const result = await prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: cutoff } },
            { revokedAt: { lt: cutoff } },
          ],
        },
      });
      if (result.count > 0) {
        logger.info(`Session cleanup: deleted ${result.count} expired/revoked sessions`);
      }
    } catch (err: any) {
      logger.warn(`Session cleanup failed: ${err.message}`);
    }
  }

  async close(): Promise<void> {
    // Disconnect Prisma used for session cleanup
    await prisma.$disconnect().catch(() => {});
  }
}
