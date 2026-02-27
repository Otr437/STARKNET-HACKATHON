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
SHA-256:  D2B35D090D7F842896CF9E5592109CF737CEDB835C8D38AAB308258EA3AB7802
SHA-512:  E35C250432E2A936E0F53BD90A9E75CE6B8FFCB488AAC712F8473009EB026F48771EAD031029C3438D833E38FEBBB1AF737909E2CA26FED5078C0FE344E5FB16
MD5:      C7D44B9786636BB3E35F3304C3644B7E
File Size: 7450 bytes

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
// ===========================================
// CORE TYPES
// ===========================================

export interface PriceData {
  symbol: string;
  price: number;
  decimals: number;
  timestamp: number;
  source: string;
  confidence?: number; // 0-100 confidence score
}

export interface AggregatedPrice {
  symbol: string;
  price: number;
  decimals: number;
  timestamp: number;
  sources: string[];
  sourceCount: number;
  median: number;
  mean: number;
  standardDeviation: number;
  confidence: number;
}

// ===========================================
// CONFIGURATION
// ===========================================

export interface OracleConfig {
  // Starknet
  rpcUrl: string;
  accountAddress: string;
  privateKey: string;
  contractAddress?: string;
  
  // API Keys
  alphaVantageKey: string;
  twelveDataKey?: string;
  polygonIoKey?: string;
  
  // Intervals & Timing
  updateInterval: number;
  maxRetries: number;
  retryDelay: number;
  apiTimeout: number;
  
  // Thresholds
  maxPriceDeviation: number;
  minSourceCount: number;
  
  // Logging
  logLevel: string;
  logToFile: boolean;
  
  // Optional Services
  slackWebhook?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  redisUrl?: string;
  redisEnabled: boolean;
  
  // Environment
  nodeEnv: string;
}

// ===========================================
// ASSET DEFINITIONS
// ===========================================

export enum AssetType {
  STOCK = 'STOCK',
  FOREX = 'FOREX',
  CRYPTO = 'CRYPTO',
  COMMODITY = 'COMMODITY',
  BOND = 'BOND',
  INDEX = 'INDEX'
}

export interface Asset {
  symbol: string;
  type: AssetType;
  name: string;
  decimals: number;
  sources: DataSource[];
  updateFrequency: number; // milliseconds
  enabled: boolean;
}

export enum DataSource {
  ALPHA_VANTAGE = 'alphavantage',
  TWELVE_DATA = 'twelve_data',
  POLYGON_IO = 'polygon_io',
  COINGECKO = 'coingecko',
  FRED = 'fred',
  BINANCE = 'binance'
}

// ===========================================
// FETCHER INTERFACES
// ===========================================

export interface IFetcher {
  name: DataSource;
  fetchPrice(symbol: string, assetType: AssetType): Promise<PriceData | null>;
  fetchMultiple(assets: Asset[]): Promise<FetcherResult>;
  isAvailable(): boolean;
}

export interface FetcherResult {
  success: boolean;
  data: PriceData[];
  errors: FetcherError[];
  timestamp: number;
  source: DataSource;
}

export interface FetcherError {
  symbol: string;
  error: string;
  timestamp: number;
  source: DataSource;
}

// ===========================================
// STARKNET INTERFACES
// ===========================================

export interface StarknetPriceUpdate {
  symbol: string;
  price: bigint;
  decimals: number;
  timestamp: number;
}

export interface TransactionResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  gasUsed?: bigint;
}

export interface ContractCall {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

// ===========================================
// AGGREGATOR INTERFACES
// ===========================================

export interface AggregationStrategy {
  aggregate(prices: PriceData[]): AggregatedPrice | null;
  validatePrice(price: PriceData, historicalPrices: PriceData[]): boolean;
}

export interface PriceValidation {
  isValid: boolean;
  reason?: string;
  deviation?: number;
}

// ===========================================
// MONITORING & ALERTS
// ===========================================

export interface Alert {
  level: AlertLevel;
  message: string;
  symbol?: string;
  data?: any;
  timestamp: number;
}

export enum AlertLevel {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

export interface HealthCheck {
  service: string;
  status: 'healthy' | 'degraded' | 'down';
  lastCheck: number;
  details?: any;
}

// ===========================================
// CACHE INTERFACES
// ===========================================

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface ICache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ===========================================
// SUPPORTED ASSETS CONFIGURATION
// ===========================================

export const SUPPORTED_ASSETS: Asset[] = [
  // Top 5 Stocks
  {
    symbol: 'AAPL',
    type: AssetType.STOCK,
    name: 'Apple Inc.',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA, DataSource.POLYGON_IO],
    updateFrequency: 900000, // 15 min
    enabled: true
  },
  {
    symbol: 'TSLA',
    type: AssetType.STOCK,
    name: 'Tesla Inc.',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA],
    updateFrequency: 900000,
    enabled: true
  },
  {
    symbol: 'NVDA',
    type: AssetType.STOCK,
    name: 'NVIDIA Corporation',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA],
    updateFrequency: 900000,
    enabled: true
  },
  {
    symbol: 'MSFT',
    type: AssetType.STOCK,
    name: 'Microsoft Corporation',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA],
    updateFrequency: 900000,
    enabled: true
  },
  {
    symbol: 'GOOGL',
    type: AssetType.STOCK,
    name: 'Alphabet Inc.',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA],
    updateFrequency: 900000,
    enabled: true
  },
  
  // Crypto
  {
    symbol: 'BTC',
    type: AssetType.CRYPTO,
    name: 'Bitcoin',
    decimals: 8,
    sources: [DataSource.COINGECKO, DataSource.BINANCE],
    updateFrequency: 300000, // 5 min
    enabled: true
  },
  {
    symbol: 'ETH',
    type: AssetType.CRYPTO,
    name: 'Ethereum',
    decimals: 8,
    sources: [DataSource.COINGECKO, DataSource.BINANCE],
    updateFrequency: 300000,
    enabled: true
  },
  
  // Commodities
  {
    symbol: 'XAU',
    type: AssetType.COMMODITY,
    name: 'Gold (XAU/USD)',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE],
    updateFrequency: 1800000, // 30 min
    enabled: true
  },
  {
    symbol: 'XAG',
    type: AssetType.COMMODITY,
    name: 'Silver (XAG/USD)',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE],
    updateFrequency: 1800000,
    enabled: true
  },
  
  // Forex
  {
    symbol: 'EURUSD',
    type: AssetType.FOREX,
    name: 'EUR/USD',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE, DataSource.TWELVE_DATA],
    updateFrequency: 900000,
    enabled: true
  },
  {
    symbol: 'GBPUSD',
    type: AssetType.FOREX,
    name: 'GBP/USD',
    decimals: 8,
    sources: [DataSource.ALPHA_VANTAGE],
    updateFrequency: 900000,
    enabled: true
  },
  
  // Bonds
  {
    symbol: 'DGS10',
    type: AssetType.BOND,
    name: 'US 10-Year Treasury Yield',
    decimals: 4,
    sources: [DataSource.FRED],
    updateFrequency: 3600000, // 1 hour
    enabled: true
  }
];

// ===========================================
// UTILITY TYPES
// ===========================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = 
  Pick<T, Exclude<keyof T, Keys>> & 
  { [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>> }[Keys];

