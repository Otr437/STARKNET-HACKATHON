/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  D325B8FE8BCD9E5AC184C454A1F62B83BC94119A8EED37EB682493436DB87494
SHA-512:  CC4A470165298D21BC43989E431185EE1F180EB3A4267CA6DE06DD95EDBB317F6922C241908C7090C925FF5F176EA58986D20DF8CDD4C4F1D71E1EEAA24B54E9
MD5:      F329B199CB4EB843F94554333578D67B
File Size: 5686 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/
import cron from 'node-cron';
import { FetcherManager } from '../fetchers/index.js';
import { PriceAggregator } from '../aggregator/price-aggregator.js';
import { StarknetPoster } from '../poster/starknet-poster.js';
import { SUPPORTED_ASSETS } from '../types.js';
import { logger, logError, logMetric } from '../utils/logger.js';
import { config } from '../config.js';

export class OracleScheduler {
  private fetcherManager: FetcherManager;
  private aggregator: PriceAggregator;
  private poster: StarknetPoster;
  private isRunning = false;
  private cronJob?: cron.ScheduledTask;
  private updateCount = 0;
  private errorCount = 0;

  constructor() {
    this.fetcherManager = new FetcherManager();
    this.aggregator = new PriceAggregator();
    this.poster = new StarknetPoster();
  }

  async initialize(): Promise<void> {
    try {
      logger.info('Initializing oracle scheduler...');

      // Initialize Starknet poster
      await this.poster.initialize();

      // Check health
      const isHealthy = await this.poster.checkHealth();
      if (!isHealthy) {
        throw new Error('Starknet poster health check failed');
      }

      logger.info({
        updateInterval: config.updateInterval,
        assets: SUPPORTED_ASSETS.filter(a => a.enabled).length,
        sources: this.fetcherManager.getAvailableSources()
      }, 'Oracle scheduler initialized successfully');

    } catch (error: any) {
      logError('OracleScheduler.initialize', error);
      throw error;
    }
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    // Calculate cron expression from update interval
    const intervalMinutes = Math.floor(config.updateInterval / 60000);
    const cronExpression = `*/${intervalMinutes} * * * *`;

    logger.info({
      interval: `${intervalMinutes} minutes`,
      cronExpression
    }, 'Starting oracle scheduler');

    // Run immediately on start
    this.runUpdate().catch(error => {
      logError('Initial update failed', error);
    });

    // Schedule periodic updates
    this.cronJob = cron.schedule(cronExpression, () => {
      this.runUpdate().catch(error => {
        logError('Scheduled update failed', error);
      });
    });

    this.isRunning = true;
    logger.info('Oracle scheduler started');
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn('Scheduler is not running');
      return;
    }

    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = undefined;
    }

    this.isRunning = false;
    logger.info('Oracle scheduler stopped');
  }

  private async runUpdate(): Promise<void> {
    const startTime = Date.now();
    logger.info('Starting oracle update cycle');

    try {
      // Get enabled assets
      const enabledAssets = SUPPORTED_ASSETS.filter(asset => asset.enabled);

      if (enabledAssets.length === 0) {
        logger.warn('No enabled assets found');
        return;
      }

      // Step 1: Fetch prices from all sources
      logger.info({ count: enabledAssets.length }, 'Fetching prices from all sources');
      const pricesBySymbol = await this.fetcherManager.fetchAll(enabledAssets);

      if (pricesBySymbol.size === 0) {
        logger.error('No prices fetched from any source');
        this.errorCount++;
        return;
      }

      // Step 2: Aggregate prices
      logger.info({ symbols: pricesBySymbol.size }, 'Aggregating prices');
      const aggregatedPrices = this.aggregator.aggregateMultiple(pricesBySymbol);

      if (aggregatedPrices.size === 0) {
        logger.error('No prices successfully aggregated');
        this.errorCount++;
        return;
      }

      // Step 3: Post to Starknet
      logger.info({ count: aggregatedPrices.size }, 'Posting prices to Starknet');
      const results = await this.poster.postMultiplePrices(aggregatedPrices);

      // Count successes and failures
      const successCount = Array.from(results.values()).filter(r => r.success).length;
      const failureCount = results.size - successCount;

      this.updateCount += successCount;
      this.errorCount += failureCount;

      // Calculate metrics
      const duration = Date.now() - startTime;
      logMetric('update_duration', duration, 'ms');
      logMetric('prices_updated', successCount);
      logMetric('update_failures', failureCount);

      logger.info({
        duration,
        fetched: pricesBySymbol.size,
        aggregated: aggregatedPrices.size,
        posted: successCount,
        failed: failureCount,
        totalUpdates: this.updateCount,
        totalErrors: this.errorCount
      }, 'Oracle update cycle completed');

    } catch (error: any) {
      this.errorCount++;
      logError('Oracle update cycle failed', error);

      const duration = Date.now() - startTime;
      logMetric('update_duration', duration, 'ms');
      logMetric('update_failures', 1);
    }
  }

  async runOnce(): Promise<void> {
    logger.info('Running one-time oracle update');
    await this.runUpdate();
  }

  getStatus(): {
    isRunning: boolean;
    updateCount: number;
    errorCount: number;
    successRate: number;
  } {
    const total = this.updateCount + this.errorCount;
    const successRate = total > 0 ? (this.updateCount / total) * 100 : 0;

    return {
      isRunning: this.isRunning,
      updateCount: this.updateCount,
      errorCount: this.errorCount,
      successRate: Math.round(successRate * 100) / 100
    };
  }

  getFetcherManager(): FetcherManager {
    return this.fetcherManager;
  }

  getAggregator(): PriceAggregator {
    return this.aggregator;
  }

  getPoster(): StarknetPoster {
    return this.poster;
  }
}

