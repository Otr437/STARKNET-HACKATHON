/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:19
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  6910DF82AF109173A2DB940335AFA5D153F1BE52452296570A84A754F8489156
SHA-512:  794F5711B5B5EA0DCEF61B0473A4C4DFC9FDFF9F6DDB81900DC58A31B318F6B328B3CBD53A28BD1BCCAD424B69AAFC2FAEFC7D42A3F55156143F124551B9B530
MD5:      87A8A32EE41438F44ECF37AFBE2ABC13
File Size: 3138 bytes

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
  IFetcher,
  PriceData,
  FetcherResult,
  FetcherError,
  Asset,
  AssetType,
  DataSource
} from '../types.js';
import { logger } from '../utils/logger.js';
import { retryWithBackoff, timeout } from '../utils/retry.js';
import { config } from '../config.js';

export abstract class BaseFetcher implements IFetcher {
  abstract name: DataSource;
  protected apiKey?: string;
  protected baseUrl: string = '';
  protected timeout: number = config.apiTimeout;

  abstract fetchPrice(symbol: string, assetType: AssetType): Promise<PriceData | null>;

  async fetchMultiple(assets: Asset[]): Promise<FetcherResult> {
    const data: PriceData[] = [];
    const errors: FetcherError[] = [];
    const startTime = Date.now();

    logger.info({ source: this.name, count: assets.length }, 'Starting batch fetch');

    for (const asset of assets) {
      if (!asset.sources.includes(this.name)) {
        continue;
      }

      try {
        const priceData = await retryWithBackoff(
          () => this.fetchPrice(asset.symbol, asset.type),
          {
            maxRetries: config.maxRetries,
            baseDelay: config.retryDelay,
            exponentialBackoff: true
          },
          `fetchPrice-${asset.symbol}`
        );

        if (priceData) {
          data.push(priceData);
          logger.info({
            source: this.name,
            symbol: asset.symbol,
            price: priceData.price
          }, 'Successfully fetched price');
        } else {
          errors.push({
            symbol: asset.symbol,
            error: 'No price data returned',
            timestamp: Date.now(),
            source: this.name
          });
        }
      } catch (error: any) {
        logger.error({
          source: this.name,
          symbol: asset.symbol,
          error: error.message
        }, 'Failed to fetch price');

        errors.push({
          symbol: asset.symbol,
          error: error.message || 'Unknown error',
          timestamp: Date.now(),
          source: this.name
        });
      }
    }

    const duration = Date.now() - startTime;
    logger.info({
      source: this.name,
      success: data.length,
      failed: errors.length,
      duration
    }, 'Batch fetch completed');

    return {
      success: data.length > 0,
      data,
      errors,
      timestamp: Date.now(),
      source: this.name
    };
  }

  isAvailable(): boolean {
    return !!this.apiKey || this.name === DataSource.COINGECKO || this.name === DataSource.FRED;
  }

  protected validatePrice(price: number, symbol: string): boolean {
    if (isNaN(price) || !isFinite(price)) {
      logger.warn({ symbol, price }, 'Invalid price: NaN or Infinite');
      return false;
    }

    if (price <= 0) {
      logger.warn({ symbol, price }, 'Invalid price: <= 0');
      return false;
    }

    return true;
  }

  protected createPriceData(
    symbol: string,
    price: number,
    decimals: number = 8,
    confidence: number = 100
  ): PriceData {
    return {
      symbol,
      price,
      decimals,
      timestamp: Date.now(),
      source: this.name,
      confidence
    };
  }
}

