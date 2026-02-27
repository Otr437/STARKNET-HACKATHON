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
SHA-256:  9AD8D123E39637EE58151B242AA17C5ABDA7D9397A7828FE8E4928C80589747F
SHA-512:  56A0F595283DC88924102DB2C8CE479654A89C0EA1C6A7F1E5B882B2161F7FC6074A4E73815E13942BC6744AAFDB8AE7EB0B166903A2F8E188E3645A2C87907E
MD5:      78B316C9170268265E5400C3B0CD33C1
File Size: 4556 bytes

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
import { IFetcher, Asset, PriceData, DataSource, FetcherResult } from '../types.js';
import { AlphaVantageFetcher } from './alphavantage.js';
import { FREDFetcher } from './fred.js';
import { CoinGeckoFetcher } from './coingecko.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export class FetcherManager {
  private fetchers: Map<DataSource, IFetcher> = new Map();

  constructor() {
    this.initializeFetchers();
  }

  private initializeFetchers(): void {
    // Alpha Vantage (stocks, forex, commodities)
    if (config.alphaVantageKey) {
      const alphaVantage = new AlphaVantageFetcher(config.alphaVantageKey);
      this.fetchers.set(DataSource.ALPHA_VANTAGE, alphaVantage);
      logger.info('Alpha Vantage fetcher initialized');
    }

    // FRED (treasury yields)
    const fred = new FREDFetcher();
    this.fetchers.set(DataSource.FRED, fred);
    logger.info('FRED fetcher initialized');

    // CoinGecko (crypto)
    const coingecko = new CoinGeckoFetcher();
    this.fetchers.set(DataSource.COINGECKO, coingecko);
    logger.info('CoinGecko fetcher initialized');

    logger.info({
      count: this.fetchers.size,
      sources: Array.from(this.fetchers.keys())
    }, 'Fetcher manager initialized');
  }

  async fetchAll(assets: Asset[]): Promise<Map<string, PriceData[]>> {
    const pricesBySymbol = new Map<string, PriceData[]>();
    const startTime = Date.now();

    logger.info({ assetCount: assets.length }, 'Starting fetch from all sources');

    // Group assets by their data sources
    const assetsBySource = this.groupAssetsBySource(assets);

    // Fetch from each source
    const fetchPromises = Array.from(assetsBySource.entries()).map(
      async ([source, sourceAssets]) => {
        const fetcher = this.fetchers.get(source);
        if (!fetcher || !fetcher.isAvailable()) {
          logger.warn({ source }, 'Fetcher not available');
          return;
        }

        try {
          const result = await fetcher.fetchMultiple(sourceAssets);
          
          // Group prices by symbol
          for (const priceData of result.data) {
            const existing = pricesBySymbol.get(priceData.symbol) || [];
            existing.push(priceData);
            pricesBySymbol.set(priceData.symbol, existing);
          }

          logger.info({
            source,
            success: result.data.length,
            errors: result.errors.length
          }, 'Source fetch completed');

        } catch (error: any) {
          logger.error({
            source,
            error: error.message
          }, 'Source fetch failed');
        }
      }
    );

    await Promise.allSettled(fetchPromises);

    const duration = Date.now() - startTime;
    logger.info({
      symbolsWithData: pricesBySymbol.size,
      totalPrices: Array.from(pricesBySymbol.values()).reduce((sum, arr) => sum + arr.length, 0),
      duration
    }, 'Fetch all completed');

    return pricesBySymbol;
  }

  async fetchAsset(asset: Asset): Promise<PriceData[]> {
    const prices: PriceData[] = [];

    for (const source of asset.sources) {
      const fetcher = this.fetchers.get(source);
      if (!fetcher || !fetcher.isAvailable()) {
        continue;
      }

      try {
        const priceData = await fetcher.fetchPrice(asset.symbol, asset.type);
        if (priceData) {
          prices.push(priceData);
        }
      } catch (error: any) {
        logger.error({
          asset: asset.symbol,
          source,
          error: error.message
        }, 'Failed to fetch from source');
      }
    }

    return prices;
  }

  private groupAssetsBySource(assets: Asset[]): Map<DataSource, Asset[]> {
    const grouped = new Map<DataSource, Asset[]>();

    for (const asset of assets) {
      if (!asset.enabled) {
        continue;
      }

      for (const source of asset.sources) {
        const existing = grouped.get(source) || [];
        existing.push(asset);
        grouped.set(source, existing);
      }
    }

    return grouped;
  }

  getFetcher(source: DataSource): IFetcher | undefined {
    return this.fetchers.get(source);
  }

  getAvailableSources(): DataSource[] {
    return Array.from(this.fetchers.keys()).filter(source => {
      const fetcher = this.fetchers.get(source);
      return fetcher?.isAvailable() || false;
    });
  }

  getStats(): { source: DataSource; available: boolean }[] {
    return Array.from(this.fetchers.entries()).map(([source, fetcher]) => ({
      source,
      available: fetcher.isAvailable()
    }));
  }
}

