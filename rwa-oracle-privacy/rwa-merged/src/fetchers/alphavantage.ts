// src/fetchers/alphavantage.ts
// ─────────────────────────────────────────────────────────────
//  Alpha Vantage — Commodities + Macroeconomic Indicators
//  Docs: https://www.alphavantage.co/documentation/
//  Free: 25 req/day | Premium: 75–1200 req/min
//
//  Commodity functions: WTI, BRENT, NATURAL_GAS, COPPER,
//                       ALUMINUM, WHEAT, CORN
//  Economic functions:  CPI, INFLATION, FEDERAL_FUNDS_RATE,
//                       TREASURY_YIELD (interval=monthly, maturity=10year)
//
//  All commodity responses look like:
//    { "name": "...", "data": [{ "date": "2025-01-01", "value": "78.50" }, ...] }
//  We take the most recent non-"." entry.
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import pRetry from "p-retry";
import { SourcePrice } from "../types";
import { logger } from "../utils/logger";

const BASE = "https://www.alphavantage.co/query";

interface AVSeriesResponse {
  name: string;
  data: Array<{ date: string; value: string }>;
}

async function fetchSeries(
  fn: string,
  params: Record<string, string>,
  apiKey: string
): Promise<{ value: number; timestamp: number } | null> {
  const { data } = await axios.get<AVSeriesResponse>(BASE, {
    params: { function: fn, apikey: apiKey, ...params },
    timeout: 15_000,
  });

  // Find most recent non-null, non-"." value
  const entry = data?.data?.find((d) => d.value && d.value !== ".");
  if (!entry) return null;

  const value = parseFloat(entry.value);
  if (isNaN(value)) return null;

  const timestamp = Math.floor(new Date(entry.date).getTime() / 1000);
  return { value, timestamp };
}

// ── Commodity definitions ─────────────────────────────────────
const COMMODITIES: Array<{
  fn: string;
  assetId: string;
  params?: Record<string, string>;
}> = [
  { fn: "WTI",         assetId: "WTI_USD",    params: { interval: "daily" } },
  { fn: "BRENT",       assetId: "BRENT_USD",  params: { interval: "daily" } },
  { fn: "NATURAL_GAS", assetId: "NATGAS_USD", params: { interval: "daily" } },
  { fn: "COPPER",      assetId: "COPPER_USD", params: { interval: "monthly" } },
  { fn: "ALUMINUM",    assetId: "ALUM_USD",   params: { interval: "monthly" } },
  { fn: "WHEAT",       assetId: "WHEAT_USD",  params: { interval: "monthly" } },
  { fn: "CORN",        assetId: "CORN_USD",   params: { interval: "monthly" } },
];

// ── Economic indicator definitions ────────────────────────────
const MACRO: Array<{
  fn: string;
  assetId: string;
  params?: Record<string, string>;
}> = [
  { fn: "CPI",                 assetId: "US_CPI",   params: { interval: "monthly" } },
  { fn: "INFLATION",           assetId: "US_INFL"  },
  { fn: "FEDERAL_FUNDS_RATE",  assetId: "FED_RATE", params: { interval: "monthly" } },
  { fn: "TREASURY_YIELD",      assetId: "US_10YR",  params: { interval: "monthly", maturity: "10year" } },
];

/**
 * Rate-limit aware sequential fetcher.
 * Alpha Vantage free tier allows 25 req/day, 5 req/min.
 * We sleep 13 seconds between calls to stay safely under.
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchWithThrottle(
  items: typeof COMMODITIES,
  apiKey: string,
  delayMs: number
): Promise<SourcePrice[]> {
  const results: SourcePrice[] = [];

  for (const item of items) {
    try {
      const result = await pRetry(
        () => fetchSeries(item.fn, item.params ?? {}, apiKey),
        {
          retries: 2,
          onFailedAttempt: (err) =>
            logger.warn(`AlphaVantage ${item.fn} attempt ${err.attemptNumber}: ${err.message}`),
        }
      );

      if (result) {
        results.push({
          source: "alphavantage",
          assetId: item.assetId,
          price: result.value,
          timestamp: result.timestamp,
        });
        logger.debug(`AlphaVantage ${item.fn}: ${result.value} @ ${result.timestamp}`);
      } else {
        logger.warn(`AlphaVantage ${item.fn}: no valid data returned`);
      }
    } catch (err: any) {
      logger.error(`AlphaVantage ${item.fn} failed: ${err.message}`);
    }

    // Throttle between calls (13s = safe for 5 req/min free tier)
    await sleep(delayMs);
  }

  return results;
}

export async function fetchAlphaVantage(): Promise<SourcePrice[]> {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey || apiKey === "YOUR_ALPHAVANTAGE_KEY") {
    logger.warn("AlphaVantage key not set — skipping");
    return [];
  }

  // Premium users can set AV_DELAY_MS=0 or lower in .env
  const delayMs = parseInt(process.env.AV_DELAY_MS ?? "13000", 10);

  logger.info(`AlphaVantage: fetching ${COMMODITIES.length + MACRO.length} series (${delayMs}ms throttle)`);

  const commodityPrices = await fetchWithThrottle(COMMODITIES, apiKey, delayMs);
  const macroPrices = await fetchWithThrottle(MACRO, apiKey, delayMs);

  return [...commodityPrices, ...macroPrices];
}
