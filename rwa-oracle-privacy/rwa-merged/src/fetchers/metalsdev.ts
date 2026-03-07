// src/fetchers/metalsdev.ts
// ─────────────────────────────────────────────────────────────
//  Metals.Dev — Precious + Industrial metals
//  Docs: https://metals.dev/api/documentation
//  Free: 100 req/month | sourced from LBMA, LME, MCX, IBJA
//
//  Endpoint: GET https://api.metals.dev/v1/latest
//  Params:   api_key, unit=toz (troy oz), currencies=USD
//  Response: { status, metals: { gold: 3248.5, silver: 32.8, ... } }
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import pRetry from "p-retry";
import { SourcePrice } from "../types";
import { logger } from "../utils/logger";

const BASE = "https://api.metals.dev/v1";

interface MetalsDevResponse {
  status: string;
  currencies: { USD: number };
  metals: {
    gold?: number;
    silver?: number;
    platinum?: number;
    palladium?: number;
    copper?: number;    // USD per troy oz
  };
  timestamps: { metal: number };
}

const METAL_MAP: Array<{ key: keyof MetalsDevResponse["metals"]; assetId: string }> = [
  { key: "gold",      assetId: "XAU_USD" },
  { key: "silver",    assetId: "XAG_USD" },
  { key: "platinum",  assetId: "XPT_USD" },
  { key: "palladium", assetId: "XPD_USD" },
  { key: "copper",    assetId: "COPPER_USD" },
];

export async function fetchMetalsDev(): Promise<SourcePrice[]> {
  const apiKey = process.env.METALS_DEV_KEY;
  if (!apiKey || apiKey === "YOUR_METALS_DEV_KEY") {
    logger.warn("Metals.Dev key not set — skipping");
    return [];
  }

  try {
    const data = await pRetry(
      async () => {
        const { data } = await axios.get<MetalsDevResponse>(`${BASE}/latest`, {
          params: { api_key: apiKey, unit: "toz", currencies: "USD" },
          timeout: 10_000,
        });
        if (data.status !== "success") throw new Error(`Metals.Dev status: ${data.status}`);
        return data;
      },
      {
        retries: 3,
        onFailedAttempt: (err) =>
          logger.warn(`Metals.Dev attempt ${err.attemptNumber}: ${err.message}`),
      }
    );

    const ts = data.timestamps?.metal ?? Math.floor(Date.now() / 1000);

    return METAL_MAP
      .filter(({ key }) => data.metals[key] !== undefined)
      .map(({ key, assetId }) => {
        const price = data.metals[key]!;
        logger.debug(`Metals.Dev ${key}: $${price}`);
        return { source: "metalsdev", assetId, price, timestamp: ts };
      });
  } catch (err: any) {
    logger.error(`Metals.Dev failed permanently: ${err.message}`);
    return [];
  }
}
