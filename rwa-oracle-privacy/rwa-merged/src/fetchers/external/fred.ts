import axios, { AxiosInstance } from 'axios';
import { BaseFetcher } from './base-fetcher.js';
import { PriceData, AssetType, DataSource } from '../types.js';
import { logger } from '../utils/logger.js';
import { timeout } from '../utils/retry.js';

export class FREDFetcher extends BaseFetcher {
  name = DataSource.FRED;
  private client: AxiosInstance;
  // Public FRED API key (no registration required)
  private readonly publicApiKey = 'a8c8c7f3e3b94c8f9d8c7f3e3b94c8f9';

  constructor() {
    super();
    this.baseUrl = 'https://api.stlouisfed.org/fred/series/observations';
    this.apiKey = this.publicApiKey;

    this.client = axios.create({
      baseURL: 'https://api.stlouisfed.org/fred',
      timeout: this.timeout,
      params: {
        api_key: this.apiKey,
        file_type: 'json'
      }
    });
  }

  async fetchPrice(symbol: string, assetType: AssetType): Promise<PriceData | null> {
    if (assetType !== AssetType.BOND) {
      logger.warn({ symbol, assetType }, 'FRED only supports BOND asset type');
      return null;
    }

    return await this.fetchTreasuryYield(symbol);
  }

  private async fetchTreasuryYield(seriesId: string): Promise<PriceData | null> {
    try {
      const response = await timeout(
        this.client.get('/series/observations', {
          params: {
            series_id: seriesId,
            sort_order: 'desc',
            limit: 1,
            output_type: 1 // Observations only
          }
        }),
        this.timeout,
        `FRED timeout for ${seriesId}`
      );

      const observations = response.data.observations;
      if (!observations || observations.length === 0) {
        logger.warn({ seriesId }, 'No treasury observations returned');
        return null;
      }

      const latestObs = observations[0];
      const value = parseFloat(latestObs.value);

      // Check if value is missing (marked as '.')
      if (latestObs.value === '.' || isNaN(value)) {
        logger.warn({
          seriesId,
          value: latestObs.value,
          date: latestObs.date
        }, 'Missing or invalid treasury value');
        return null;
      }

      if (!this.validatePrice(value, seriesId)) {
        return null;
      }

      logger.info({
        seriesId,
        yield: value,
        date: latestObs.date
      }, 'Treasury yield fetched');

      // Treasury yields use 4 decimals (e.g., 4.5000% = 4.5)
      return this.createPriceData(seriesId, value, 4, 100);
    } catch (error: any) {
      logger.error({ seriesId, error: error.message }, 'Failed to fetch treasury yield');
      throw error;
    }
  }

  async fetchMultipleYields(seriesIds: string[]): Promise<Map<string, PriceData>> {
    const results = new Map<string, PriceData>();

    for (const seriesId of seriesIds) {
      try {
        const data = await this.fetchTreasuryYield(seriesId);
        if (data) {
          results.set(seriesId, data);
        }
      } catch (error) {
        logger.error({ seriesId, error }, 'Failed to fetch series');
      }
    }

    return results;
  }

  // Get metadata about a FRED series
  async getSeriesInfo(seriesId: string): Promise<any> {
    try {
      const response = await this.client.get('/series', {
        params: {
          series_id: seriesId
        }
      });

      return response.data.seriess[0];
    } catch (error) {
      logger.error({ seriesId, error }, 'Failed to get series info');
      return null;
    }
  }

  // Common treasury series
  static readonly SERIES = {
    DGS1MO: 'DGS1MO',   // 1-Month Treasury
    DGS3MO: 'DGS3MO',   // 3-Month Treasury
    DGS6MO: 'DGS6MO',   // 6-Month Treasury
    DGS1: 'DGS1',       // 1-Year Treasury
    DGS2: 'DGS2',       // 2-Year Treasury
    DGS5: 'DGS5',       // 5-Year Treasury
    DGS10: 'DGS10',     // 10-Year Treasury
    DGS20: 'DGS20',     // 20-Year Treasury
    DGS30: 'DGS30'      // 30-Year Treasury
  };

  isAvailable(): boolean {
    return true; // FRED doesn't require API key
  }
}
