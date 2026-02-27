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
SHA-256:  809EEE9406F909363692A5A4A5563D3F6A1681E62A88B80CD96A7A8814754246
SHA-512:  7D95876C1B895F90EC698B6BEAA9097E8360BCE1E2F9255A6A18A8348B000B9ED66BFCBB49C394648FC47FA5F9B180C60DF54827BC8A044F5851CC3553E7BC76
MD5:      63BD60596ECD5D0584A1F53203A1BD52
File Size: 7565 bytes

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
import {
  PriceData,
  AggregatedPrice,
  AggregationStrategy,
  PriceValidation
} from '../types.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export class MedianAggregationStrategy implements AggregationStrategy {
  aggregate(prices: PriceData[]): AggregatedPrice | null {
    if (prices.length === 0) {
      return null;
    }

    // Sort prices
    const sortedPrices = [...prices].sort((a, b) => a.price - b.price);
    
    // Calculate median
    const median = this.calculateMedian(sortedPrices.map(p => p.price));
    
    // Calculate mean
    const mean = sortedPrices.reduce((sum, p) => sum + p.price, 0) / sortedPrices.length;
    
    // Calculate standard deviation
    const variance = sortedPrices.reduce((sum, p) => sum + Math.pow(p.price - mean, 2), 0) / sortedPrices.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Calculate confidence based on source count and deviation
    const confidence = this.calculateConfidence(sortedPrices.length, standardDeviation, mean);
    
    // Use first price's metadata
    const firstPrice = prices[0];
    
    return {
      symbol: firstPrice.symbol,
      price: median,
      decimals: firstPrice.decimals,
      timestamp: Date.now(),
      sources: prices.map(p => p.source),
      sourceCount: prices.length,
      median,
      mean,
      standardDeviation,
      confidence
    };
  }

  validatePrice(price: PriceData, historicalPrices: PriceData[]): boolean {
    // Validate the price is positive and finite
    if (!isFinite(price.price) || price.price <= 0) {
      logger.warn({ price }, 'Invalid price: not positive or not finite');
      return false;
    }

    // If no historical data, accept the price
    if (historicalPrices.length === 0) {
      return true;
    }

    // Calculate recent average
    const recentPrices = historicalPrices.slice(-10);
    const avgPrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;

    // Check deviation from recent average
    const deviation = Math.abs((price.price - avgPrice) / avgPrice) * 100;

    if (deviation > config.maxPriceDeviation) {
      logger.warn({
        symbol: price.symbol,
        price: price.price,
        avgPrice,
        deviation: deviation.toFixed(2) + '%',
        threshold: config.maxPriceDeviation + '%'
      }, 'Price deviation exceeds threshold');
      return false;
    }

    return true;
  }

  private calculateMedian(values: number[]): number {
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0
      ? (values[mid - 1] + values[mid]) / 2
      : values[mid];
  }

  private calculateConfidence(sourceCount: number, stdDev: number, mean: number): number {
    // Base confidence on number of sources
    let confidence = Math.min(50 + (sourceCount * 10), 90);

    // Adjust for price consistency (coefficient of variation)
    const coefficientOfVariation = (stdDev / mean) * 100;
    
    if (coefficientOfVariation < 0.1) {
      confidence += 10; // Very consistent
    } else if (coefficientOfVariation < 0.5) {
      confidence += 5; // Moderately consistent
    } else if (coefficientOfVariation > 2) {
      confidence -= 10; // High variance
    }

    return Math.max(0, Math.min(100, confidence));
  }
}

export class PriceAggregator {
  private strategy: AggregationStrategy;
  private priceHistory: Map<string, PriceData[]> = new Map();
  private readonly MAX_HISTORY = 100;

  constructor(strategy: AggregationStrategy = new MedianAggregationStrategy()) {
    this.strategy = strategy;
  }

  aggregate(symbol: string, prices: PriceData[]): AggregatedPrice | null {
    if (prices.length === 0) {
      logger.warn({ symbol }, 'No prices to aggregate');
      return null;
    }

    // Filter out invalid prices
    const validPrices = prices.filter(price => {
      const historical = this.priceHistory.get(symbol) || [];
      return this.strategy.validatePrice(price, historical);
    });

    if (validPrices.length === 0) {
      logger.warn({ symbol, attempted: prices.length }, 'All prices invalid after validation');
      return null;
    }

    // Aggregate valid prices
    const aggregated = this.strategy.aggregate(validPrices);

    if (aggregated) {
      // Store aggregated result in history
      this.addToHistory(symbol, {
        symbol,
        price: aggregated.price,
        decimals: aggregated.decimals,
        timestamp: aggregated.timestamp,
        source: 'aggregated',
        confidence: aggregated.confidence
      });

      logger.info({
        symbol,
        price: aggregated.price,
        sources: aggregated.sourceCount,
        confidence: aggregated.confidence,
        deviation: ((aggregated.standardDeviation / aggregated.mean) * 100).toFixed(2) + '%'
      }, 'Price aggregated');
    }

    return aggregated;
  }

  aggregateMultiple(pricesBySymbol: Map<string, PriceData[]>): Map<string, AggregatedPrice> {
    const results = new Map<string, AggregatedPrice>();

    for (const [symbol, prices] of pricesBySymbol.entries()) {
      const aggregated = this.aggregate(symbol, prices);
      if (aggregated) {
        results.set(symbol, aggregated);
      }
    }

    logger.info({
      symbols: results.size,
      total: pricesBySymbol.size
    }, 'Multiple prices aggregated');

    return results;
  }

  private addToHistory(symbol: string, price: PriceData): void {
    const history = this.priceHistory.get(symbol) || [];
    history.push(price);

    // Keep only recent history
    if (history.length > this.MAX_HISTORY) {
      history.shift();
    }

    this.priceHistory.set(symbol, history);
  }

  getHistory(symbol: string, count?: number): PriceData[] {
    const history = this.priceHistory.get(symbol) || [];
    return count ? history.slice(-count) : history;
  }

  validateNewPrice(symbol: string, price: PriceData): PriceValidation {
    const historical = this.priceHistory.get(symbol) || [];
    const isValid = this.strategy.validatePrice(price, historical);

    if (!isValid && historical.length > 0) {
      const avgPrice = historical.reduce((sum, p) => sum + p.price, 0) / historical.length;
      const deviation = Math.abs((price.price - avgPrice) / avgPrice) * 100;

      return {
        isValid: false,
        reason: `Price deviation ${deviation.toFixed(2)}% exceeds threshold`,
        deviation
      };
    }

    return { isValid: true };
  }

  clearHistory(symbol?: string): void {
    if (symbol) {
      this.priceHistory.delete(symbol);
      logger.info({ symbol }, 'History cleared for symbol');
    } else {
      this.priceHistory.clear();
      logger.info('All price history cleared');
    }
  }

  getStats(symbol: string): any {
    const history = this.priceHistory.get(symbol) || [];
    
    if (history.length === 0) {
      return null;
    }

    const prices = history.map(p => p.price);
    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const median = sortedPrices.length % 2 === 0
      ? (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2
      : sortedPrices[Math.floor(sortedPrices.length / 2)];

    return {
      symbol,
      count: history.length,
      mean,
      median,
      min: Math.min(...prices),
      max: Math.max(...prices),
      latest: history[history.length - 1].price,
      firstTimestamp: history[0].timestamp,
      lastTimestamp: history[history.length - 1].timestamp
    };
  }
}

