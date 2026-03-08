// src/fetchers/metalpriceapi.ts
// ─────────────────────────────────────────────────────────────
//  MetalpriceAPI.com — Gold, Silver, Platinum, Palladium
//  Docs: https://metalpriceapi.com/documentation
//  Free: 100 req/month | returns rates as USD per troy oz
//
//  Endpoint: GET https://api.metalpriceapi.com/v1/latest
//  Params:   api_key, base=USD, currencies=XAU,XAG,XPT,XPD
//  Note: API returns price of 1 USD in metal units (inverted!)
//        so we invert: usd_price = 1 / rate
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import pRetry from "p-retry";
import { SourcePrice } from "../types";
import { logger } from "../utils/logger";

const BASE = "https://api.metalpriceapi.com/v1";

interface MetalPriceResponse {
  success: boolean;
  timestamp: number;
  base: string;         // "USD"
  rates: Record<string, number>;  // e.g. { XAU: 0.000308, XAG: 0.0322 }
}

const METALS: Array<{ symbol: string; assetId: string }> = [
  { symbol: "XAU", assetId: "XAU_USD" },
  { symbol: "XAG", assetId: "XAG_USD" },
  { symbol: "XPT", assetId: "XPT_USD" },
  { symbol: "XPD", assetId: "XPD_USD" },
];

export async function fetchMetalpriceApi(): Promise<SourcePrice[]> {
  const apiKey = process.env.METALPRICEAPI_KEY;
  if (!apiKey || apiKey === "YOUR_METALPRICEAPI_KEY") {
    logger.warn("MetalpriceAPI key not set — skipping");
    return [];
  }

  try {
    const data = await pRetry(
      async () => {
        const { data } = await axios.get<MetalPriceResponse>(`${BASE}/latest`, {
          params: {
            api_key: apiKey,
            base: "USD",
            currencies: METALS.map((m) => m.symbol).join(","),
          },
          timeout: 10_000,
        });
        if (!data.success) throw new Error("MetalpriceAPI returned success=false");
        return data;
      },
      {
        retries: 3,
        onFailedAttempt: (err) =>
          logger.warn(`MetalpriceAPI attempt ${err.attemptNumber} failed: ${err.message}`),
      }
    );

    return METALS.map(({ symbol, assetId }) => {
      // Rates are: 1 USD = rate METAL => 1 METAL = 1/rate USD
      const rate = data.rates[symbol];
      const usdPrice = rate && rate > 0 ? 1 / rate : 0;
      logger.debug(`MetalpriceAPI ${symbol}: $${usdPrice.toFixed(4)}`);
      return {
        source: "metalpriceapi",
        assetId,
        price: usdPrice,
        timestamp: data.timestamp,
      };
    }).filter((s) => s.price > 0);
  } catch (err: any) {
    logger.error(`MetalpriceAPI failed permanently: ${err.message}`);
    return [];
  }
}
