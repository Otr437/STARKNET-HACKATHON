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
SHA-256:  3BA5D1E9A1D66839D36DCB86249E03C8CF630ACDD5996D3F3D0FEAB1101B7276
SHA-512:  DD7A74BDC76A42FB072D4744079A2792F54E528C5EF19D4878EF149B3164250E3AC817414C845D5F7D8F87FFE9AF5CAB5A9B00518C4627B0B21979A85956E88A
MD5:      7F190D386C5CB5C590F5C3588C09EB94
File Size: 6925 bytes

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
import axiosRetry from 'axios-retry';
import { BaseFetcher } from './base-fetcher.js';
import { PriceData, AssetType, DataSource } from '../types.js';
import { logger } from '../utils/logger.js';
import { sleep, timeout } from '../utils/retry.js';
import { config } from '../config.js';

export class AlphaVantageFetcher extends BaseFetcher {
  name = DataSource.ALPHA_VANTAGE;
  private client: AxiosInstance;
  private requestCount = 0;
  private lastRequestTime = 0;
  private readonly REQUEST_DELAY = 12000; // 12 seconds (5 calls/min for free tier)

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.alphavantage.co/query';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout
    });

    // Add retry logic for network errors
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
               error.response?.status === 429;
      }
    });
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.REQUEST_DELAY) {
      const waitTime = this.REQUEST_DELAY - timeSinceLastRequest;
      logger.debug({ waitTime }, 'Rate limiting API request');
      await sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  async fetchPrice(symbol: string, assetType: AssetType): Promise<PriceData | null> {
    await this.rateLimit();

    try {
      switch (assetType) {
        case AssetType.STOCK:
          return await this.fetchStock(symbol);
        case AssetType.FOREX:
          return await this.fetchForex(symbol);
        case AssetType.COMMODITY:
          return await this.fetchCommodity(symbol);
        default:
          logger.warn({ symbol, assetType }, 'Unsupported asset type for Alpha Vantage');
          return null;
      }
    } catch (error: any) {
      logger.error({ symbol, assetType, error: error.message }, 'Alpha Vantage fetch failed');
      throw error;
    }
  }

  private async fetchStock(symbol: string): Promise<PriceData | null> {
    try {
      const response = await timeout(
        this.client.get('', {
          params: {
            function: 'GLOBAL_QUOTE',
            symbol: symbol,
            apikey: this.apiKey
          }
        }),
        this.timeout,
        `Alpha Vantage timeout for ${symbol}`
      );

      // Check for API error messages
      if (response.data.Note) {
        throw new Error('API rate limit reached');
      }

      if (response.data['Error Message']) {
        throw new Error(response.data['Error Message']);
      }

      const quote = response.data['Global Quote'];
      if (!quote || !quote['05. price']) {
        logger.warn({ symbol, response: response.data }, 'No quote data returned');
        return null;
      }

      const price = parseFloat(quote['05. price']);
      const change = parseFloat(quote['09. change'] || '0');
      const changePercent = parseFloat(quote['10. change percent']?.replace('%', '') || '0');

      if (!this.validatePrice(price, symbol)) {
        return null;
      }

      logger.info({
        symbol,
        price,
        change,
        changePercent
      }, 'Stock price fetched');

      return this.createPriceData(symbol, price, 8, 95);
    } catch (error: any) {
      logger.error({ symbol, error: error.message }, 'Failed to fetch stock');
      throw error;
    }
  }

  private async fetchForex(pair: string): Promise<PriceData | null> {
    try {
      // Parse forex pair (e.g., EURUSD -> EUR, USD)
      if (pair.length !== 6) {
        throw new Error(`Invalid forex pair format: ${pair}`);
      }

      const fromCurrency = pair.slice(0, 3);
      const toCurrency = pair.slice(3, 6);

      const response = await timeout(
        this.client.get('', {
          params: {
            function: 'CURRENCY_EXCHANGE_RATE',
            from_currency: fromCurrency,
            to_currency: toCurrency,
            apikey: this.apiKey
          }
        }),
        this.timeout,
        `Alpha Vantage timeout for ${pair}`
      );

      if (response.data.Note) {
        throw new Error('API rate limit reached');
      }

      if (response.data['Error Message']) {
        throw new Error(response.data['Error Message']);
      }

      const data = response.data['Realtime Currency Exchange Rate'];
      if (!data || !data['5. Exchange Rate']) {
        logger.warn({ pair, response: response.data }, 'No forex data returned');
        return null;
      }

      const price = parseFloat(data['5. Exchange Rate']);
      const bidPrice = parseFloat(data['8. Bid Price'] || price);
      const askPrice = parseFloat(data['9. Ask Price'] || price);

      if (!this.validatePrice(price, pair)) {
        return null;
      }

      logger.info({
        pair,
        price,
        bid: bidPrice,
        ask: askPrice,
        spread: askPrice - bidPrice
      }, 'Forex rate fetched');

      return this.createPriceData(pair, price, 8, 95);
    } catch (error: any) {
      logger.error({ pair, error: error.message }, 'Failed to fetch forex');
      throw error;
    }
  }

  private async fetchCommodity(symbol: string): Promise<PriceData | null> {
    try {
      // For gold (XAU) and silver (XAG), fetch against USD
      const commodity = symbol === 'XAU' ? 'XAU' : symbol === 'XAG' ? 'XAG' : symbol;

      const response = await timeout(
        this.client.get('', {
          params: {
            function: 'CURRENCY_EXCHANGE_RATE',
            from_currency: commodity,
            to_currency: 'USD',
            apikey: this.apiKey
          }
        }),
        this.timeout,
        `Alpha Vantage timeout for ${symbol}`
      );

      if (response.data.Note) {
        throw new Error('API rate limit reached');
      }

      if (response.data['Error Message']) {
        throw new Error(response.data['Error Message']);
      }

      const data = response.data['Realtime Currency Exchange Rate'];
      if (!data || !data['5. Exchange Rate']) {
        logger.warn({ symbol, response: response.data }, 'No commodity data returned');
        return null;
      }

      const price = parseFloat(data['5. Exchange Rate']);

      if (!this.validatePrice(price, symbol)) {
        return null;
      }

      logger.info({ symbol, price }, 'Commodity price fetched');

      return this.createPriceData(symbol, price, 8, 90);
    } catch (error: any) {
      logger.error({ symbol, error: error.message }, 'Failed to fetch commodity');
      throw error;
    }
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  resetRequestCount(): void {
    this.requestCount = 0;
  }
}

