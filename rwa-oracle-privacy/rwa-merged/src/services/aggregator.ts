// src/aggregator/index.ts
// ─────────────────────────────────────────────────────────────
//  Multi-source price aggregator
//
//  Strategy:
//    1. Group all SourcePrices by assetId
//    2. For each asset, compute median across sources
//    3. Reject any asset where any source deviates > MAX_DEVIATION_PCT
//       from the median (bad feed protection)
//    4. Require at least MIN_SOURCES for any asset to be submitted
// ─────────────────────────────────────────────────────────────

import { AggregatedPrice, SourcePrice } from "../types";
import { logger } from "../utils/logger";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregate(allPrices: SourcePrice[]): AggregatedPrice[] {
  const minSources = parseInt(process.env.MIN_SOURCES ?? "2", 10);
  const maxDeviationPct = parseFloat(process.env.MAX_DEVIATION_PCT ?? "5");

  // Group by assetId
  const byAsset = new Map<string, SourcePrice[]>();
  for (const sp of allPrices) {
    if (!byAsset.has(sp.assetId)) byAsset.set(sp.assetId, []);
    byAsset.get(sp.assetId)!.push(sp);
  }

  const result: AggregatedPrice[] = [];

  for (const [assetId, sources] of byAsset.entries()) {
    if (sources.length < minSources) {
      logger.warn(
        `${assetId}: only ${sources.length}/${minSources} sources — skipping`
      );
      continue;
    }

    const prices = sources.map((s) => s.price);
    const med = median(prices);

    // Deviation check
    const deviating = sources.filter((s) => {
      const pct = Math.abs(s.price - med) / med * 100;
      return pct > maxDeviationPct;
    });

    if (deviating.length > 0) {
      logger.warn(
        `${assetId}: sources deviate >  ${maxDeviationPct}% from median $${med.toFixed(4)}:`,
        deviating.map((s) => `${s.source}=$${s.price.toFixed(4)}`)
      );
      // Remove outliers and re-check source count
      const clean = sources.filter((s) => !deviating.includes(s));
      if (clean.length < minSources) {
        logger.warn(`${assetId}: after outlier removal only ${clean.length} sources — skipping`);
        continue;
      }
      // Recompute median on clean sources
      const cleanMed = median(clean.map((s) => s.price));
      const ts = Math.max(...clean.map((s) => s.timestamp));
      result.push({ assetId, medianPrice: cleanMed, sources: clean, timestamp: ts });
      logger.info(`${assetId}: aggregated (cleaned) $${cleanMed.toFixed(6)} from ${clean.length} sources`);
    } else {
      const ts = Math.max(...sources.map((s) => s.timestamp));
      result.push({ assetId, medianPrice: med, sources, timestamp: ts });
      logger.info(`${assetId}: aggregated $${med.toFixed(6)} from ${sources.length} sources`);
    }
  }

  return result;
}
