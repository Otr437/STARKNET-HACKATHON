// src/fetchers/goldapi.ts
// ─────────────────────────────────────────────────────────────
//  GoldAPI.io  — Real-time XAU and XAG spot prices
//  Docs: https://www.goldapi.io/api/
//  Free: 100 req/month | Premium: unlimited
//
//  Endpoint: GET https://www.goldapi.io/api/{METAL}/USD
//  Headers:  x-access-token: YOUR_KEY
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import pRetry from "p-retry";
import { SourcePrice } from "../types";
import { logger } from "../utils/logger";

const BASE = "https://www.goldapi.io/api";

interface GoldApiResponse {
  timestamp: number;
  metal: string;        // "XAU" | "XAG"
  currency: string;     // "USD"
  price: number;        // mid price
  ask: number;
  bid: number;
}

async function fetchMetal(metal: "XAU" | "XAG", apiKey: string): Promise<SourcePrice> {
  const { data } = await axios.get<GoldApiResponse>(`${BASE}/${metal}/USD`, {
    headers: { "x-access-token": apiKey },
    timeout: 10_000,
  });

  return {
    source: "goldapi",
    assetId: `${metal}_USD`,
    price: data.price,
    timestamp: data.timestamp,
  };
}

export async function fetchGoldApi(): Promise<SourcePrice[]> {
  const apiKey = process.env.GOLDAPI_KEY;
  if (!apiKey || apiKey === "YOUR_GOLDAPI_KEY") {
    logger.warn("GoldAPI key not set — skipping");
    return [];
  }

  const results: SourcePrice[] = [];

  for (const metal of ["XAU", "XAG"] as const) {
    try {
      const price = await pRetry(() => fetchMetal(metal, apiKey), {
        retries: 3,
        onFailedAttempt: (err) =>
          logger.warn(`GoldAPI ${metal} attempt ${err.attemptNumber} failed: ${err.message}`),
      });
      results.push(price);
      logger.debug(`GoldAPI ${metal}: $${price.price}`);
    } catch (err: any) {
      logger.error(`GoldAPI ${metal} failed permanently: ${err.message}`);
    }
  }

  return results;
}
