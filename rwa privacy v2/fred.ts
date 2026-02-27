/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:20
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  3AC29D450897F61B16F7F64EA5204BF8979000B53DA3F78C8C82314282232F28
SHA-512:  87B9AC9A1C53B3F95A3EDB26A4B0C883C8C25585EAFDE67D7D2B46E690E57E52608A211AF548431454EA5650DA7C4CA1CE0526DBEC3B836F19159AD770478092
MD5:      CDA17C2BAE89BDA842BE3BEEF540A89C
File Size: 3994 bytes

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

