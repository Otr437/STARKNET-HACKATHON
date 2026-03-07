// src/index.ts — RWA Oracle Feeder (PRODUCTION)
import "dotenv/config";
import cron from "node-cron";
import { logger } from "./utils/logger";
import { fetchGoldApi } from "./fetchers/goldapi";
import { fetchMetalpriceApi } from "./fetchers/metalpriceapi";
import { fetchMetalsDev } from "./fetchers/metalsdev";
import { fetchAlphaVantage } from "./fetchers/alphavantage";
import { aggregate } from "./services/aggregator";
import { OracleSubmitter } from "./services/submitter";
import { AdminApiClient } from "./services/adminApiClient";
import { AlertEngine } from "./services/alertEngine";
import { CircuitBreaker } from "./utils/circuitBreaker";
import { HealthMonitor, updateLastCycleAt } from "./utils/healthMonitor";
import { SourcePrice } from "./types";

function validateEnv(): void {
  const required = [
    "STARKNET_ACCOUNT_ADDRESS",
    "STARKNET_PRIVATE_KEY",
    "ORACLE_CONTRACT_ADDRESS",
    "STARKNET_RPC_URL",
    "DATABASE_URL",
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function runFeedCycle(
  submitter: OracleSubmitter,
  adminApi: AdminApiClient,
  alertEngine: AlertEngine,
  starknetBreaker: CircuitBreaker
): Promise<void> {
  logger.info("══════════════ Starting feed cycle ══════════════");

  const [goldApiPrices, metalpriceApiPrices, metalsDevPrices] = await Promise.all([
    fetchGoldApi(),
    fetchMetalpriceApi(),
    fetchMetalsDev(),
  ]);

  const avCycleCount = parseInt(process.env.AV_FETCH_EVERY_N_CYCLES ?? "4", 10);
  const cycleNumber = Math.floor(Date.now() / 1000 / 60 / 15);
  let alphaVantagePrices: SourcePrice[] = [];
  if (cycleNumber % avCycleCount === 0) {
    logger.info("AlphaVantage fetch cycle — fetching macro + commodity data");
    alphaVantagePrices = await fetchAlphaVantage();
  } else {
    logger.info(`Skipping AlphaVantage this cycle (runs every ${avCycleCount} cycles)`);
  }

  const allPrices: SourcePrice[] = [
    ...goldApiPrices,
    ...metalpriceApiPrices,
    ...metalsDevPrices,
    ...alphaVantagePrices,
  ];

  logger.info(`Total raw price readings: ${allPrices.length}`);

  // Update last cycle timestamp regardless of whether we got prices
  updateLastCycleAt();

  if (allPrices.length === 0) {
    logger.warn("No prices fetched from any source — check API keys and quotas");
    await alertEngine.fireSourceDownAlerts([]);
    return;
  }

  // Persist raw readings (fire and forget, chunked to respect API limits)
  adminApi.persistRawFeeds(allPrices).catch((err) =>
    logger.warn(`Failed to persist raw feeds: ${err.message}`)
  );

  const activeSources = [...new Set(allPrices.map((p) => p.source))];
  await alertEngine.checkSourceHealth(activeSources);

  const aggregated = aggregate(allPrices);
  logger.info(`Aggregated ${aggregated.length} assets ready for submission`);

  if (aggregated.length === 0) {
    logger.warn("No assets passed aggregation — check MIN_SOURCES and MAX_DEVIATION_PCT");
    return;
  }

  // Submit — circuit breaker returns null if OPEN (don't throw, just skip)
  let submitResults = null;
  try {
    submitResults = await starknetBreaker.execute(() =>
      submitter.submitPrices(aggregated)
    );
  } catch (err: any) {
    logger.error(`StarkNet submission error: ${err.message}`);
    // Fire SUBMISSION_FAILED alerts for all assets
    for (const agg of aggregated) {
      await alertEngine.fireSubmissionFailedAlert(agg.assetId, err.message);
    }
  }

  if (submitResults) {
    await adminApi.persistPriceHistory(submitResults).catch((err) =>
      logger.warn(`Failed to persist price history: ${err.message}`)
    );
    await alertEngine.checkDeviationAlerts(aggregated);

    // Fire SUBMISSION_FAILED alert for any individual failures
    for (const r of submitResults.filter((r) => r.status === "FAILED")) {
      await alertEngine.fireSubmissionFailedAlert(r.assetId, r.errorMessage ?? "unknown");
    }
  }

  logger.info("══════════════ Feed cycle complete ══════════════\n");
}

async function main(): Promise<void> {
  logger.info("RWA Oracle Feeder starting up (PRODUCTION MODE)...");
  validateEnv();

  const submitter     = new OracleSubmitter();
  const adminApi      = new AdminApiClient();
  const alertEngine   = new AlertEngine();
  const healthMonitor = new HealthMonitor(submitter);

  const starknetBreaker = new CircuitBreaker("starknet-rpc", {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60_000,
    onOpen:     () => logger.error("StarkNet circuit breaker OPEN — pausing submissions"),
    onClose:    () => logger.info("StarkNet circuit breaker CLOSED — resuming"),
    onHalfOpen: () => logger.info("StarkNet circuit breaker HALF-OPEN — probing"),
  });

  await adminApi.authenticate();

  logger.info("Checking asset registration on-chain...");
  await submitter.registerMissingAssets();

  await healthMonitor.runChecks();
  await runFeedCycle(submitter, adminApi, alertEngine, starknetBreaker);

  const cronExpr = process.env.FEED_CRON ?? "*/15 * * * *";
  logger.info(`Feed cycle scheduled: ${cronExpr}`);

  cron.schedule(cronExpr, async () => {
    try {
      await runFeedCycle(submitter, adminApi, alertEngine, starknetBreaker);
    } catch (err: any) {
      logger.error(`Unhandled error in feed cycle: ${err.message}`, { stack: err.stack });
    }
  });

  // Health checks every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try { await healthMonitor.runChecks(); }
    catch (err: any) { logger.warn(`Health monitor error: ${err.message}`); }
  });

  // Staleness alerts every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    try { await alertEngine.checkStalenessAlerts(); }
    catch (err: any) { logger.warn(`Staleness alert check error: ${err.message}`); }
  });

  // Session cleanup every 6 hours — delete expired/revoked sessions older than 30 days
  cron.schedule("0 */6 * * *", async () => {
    try { await adminApi.cleanupExpiredSessions(); }
    catch (err: any) { logger.warn(`Session cleanup error: ${err.message}`); }
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down feeder cleanly`);
    await adminApi.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  logger.info("Feeder running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
