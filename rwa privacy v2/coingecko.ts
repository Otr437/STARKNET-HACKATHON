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
SHA-256:  3477E25E350497A0586AF12A1EFAEB924EB623401B7388DFCB39C6893B5C0ADD
SHA-512:  0196BAD6FB732C4C3EB66087E7502D04A91008B039C68BC95A3360BF562DD817EB578DC3B59D131F26DC3F83202FBB0B5686673662EA63C25F5B1190EE31A590
MD5:      96E95D696E3FCB5494F72087A232B729
File Size: 5668 bytes

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
import { timeout, sleep } from '../utils/retry.js';

export class CoinGeckoFetcher extends BaseFetcher {
  name = DataSource.COINGECKO;
  private client: AxiosInstance;
  private lastRequestTime = 0;
  private readonly REQUEST_DELAY = 1100; // 1.1 seconds (CoinGecko free tier: ~50 calls/min)

  private readonly COIN_MAP: Map<string, string> = new Map([
    ['BTC', 'bitcoin'],
    ['ETH', 'ethereum'],
    ['USDT', 'tether'],
    ['BNB', 'binancecoin'],
    ['SOL', 'solana'],
    ['USDC', 'usd-coin'],
    ['XRP', 'ripple'],
    ['ADA', 'cardano'],
    ['AVAX', 'avalanche-2'],
    ['DOGE', 'dogecoin']
  ]);

  constructor() {
    super();
    this.baseUrl = 'https://api.coingecko.com/api/v3';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json'
      }
    });
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.REQUEST_DELAY) {
      const waitTime = this.REQUEST_DELAY - timeSinceLastRequest;
      await sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
  }

  async fetchPrice(symbol: string, assetType: AssetType): Promise<PriceData | null> {
    if (assetType !== AssetType.CRYPTO) {
      logger.warn({ symbol, assetType }, 'CoinGecko only supports CRYPTO asset type');
      return null;
    }

    await this.rateLimit();

    const coinId = this.COIN_MAP.get(symbol);
    if (!coinId) {
      logger.warn({ symbol }, 'Unknown cryptocurrency symbol');
      return null;
    }

    try {
      const response = await timeout(
        this.client.get('/simple/price', {
          params: {
            ids: coinId,
            vs_currencies: 'usd',
            include_24hr_change: 'true',
            include_market_cap: 'true',
            include_24hr_vol: 'true'
          }
        }),
        this.timeout,
        `CoinGecko timeout for ${symbol}`
      );

      const data = response.data[coinId];
      if (!data || !data.usd) {
        logger.warn({ symbol, coinId, response: response.data }, 'No price data returned');
        return null;
      }

      const price = data.usd;
      const change24h = data.usd_24h_change || 0;
      const marketCap = data.usd_market_cap || 0;
      const volume24h = data.usd_24h_vol || 0;

      if (!this.validatePrice(price, symbol)) {
        return null;
      }

      logger.info({
        symbol,
        price,
        change24h: change24h.toFixed(2) + '%',
        marketCap: marketCap.toLocaleString(),
        volume24h: volume24h.toLocaleString()
      }, 'Crypto price fetched');

      // Higher confidence for liquid markets
      const confidence = volume24h > 1000000000 ? 100 : 95;

      return this.createPriceData(symbol, price, 8, confidence);
    } catch (error: any) {
      logger.error({ symbol, coinId, error: error.message }, 'Failed to fetch crypto price');
      throw error;
    }
  }

  async fetchMultiplePrices(symbols: string[]): Promise<Map<string, PriceData>> {
    const results = new Map<string, PriceData>();

    // Convert symbols to coin IDs
    const coinIds = symbols
      .map(symbol => this.COIN_MAP.get(symbol))
      .filter((id): id is string => id !== undefined);

    if (coinIds.length === 0) {
      logger.warn({ symbols }, 'No valid coin IDs found');
      return results;
    }

    await this.rateLimit();

    try {
      const response = await timeout(
        this.client.get('/simple/price', {
          params: {
            ids: coinIds.join(','),
            vs_currencies: 'usd',
            include_24hr_change: 'true'
          }
        }),
        this.timeout * 2,
        'CoinGecko batch request timeout'
      );

      // Map results back to symbols
      for (const [symbol, coinId] of this.COIN_MAP.entries()) {
        if (symbols.includes(symbol) && response.data[coinId]) {
          const data = response.data[coinId];
          const price = data.usd;

          if (this.validatePrice(price, symbol)) {
            results.set(symbol, this.createPriceData(symbol, price, 8, 95));
          }
        }
      }

      logger.info({
        requested: symbols.length,
        fetched: results.size
      }, 'Batch crypto prices fetched');

    } catch (error: any) {
      logger.error({ symbols, error: error.message }, 'Failed to fetch batch crypto prices');
    }

    return results;
  }

  // Get detailed market data
  async getMarketData(symbol: string): Promise<any> {
    const coinId = this.COIN_MAP.get(symbol);
    if (!coinId) {
      return null;
    }

    await this.rateLimit();

    try {
      const response = await this.client.get(`/coins/${coinId}`, {
        params: {
          localization: 'false',
          tickers: 'false',
          community_data: 'false',
          developer_data: 'false'
        }
      });

      return response.data;
    } catch (error) {
      logger.error({ symbol, coinId, error }, 'Failed to get market data');
      return null;
    }
  }

  isAvailable(): boolean {
    return true; // No API key required for free tier
  }

  // Add a new coin to the map
  addCoin(symbol: string, coinId: string): void {
    this.COIN_MAP.set(symbol, coinId);
    logger.info({ symbol, coinId }, 'Added new coin mapping');
  }

  // Get all supported coins
  getSupportedCoins(): string[] {
    return Array.from(this.COIN_MAP.keys());
  }
}

