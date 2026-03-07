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
