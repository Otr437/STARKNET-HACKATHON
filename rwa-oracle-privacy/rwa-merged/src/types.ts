// src/types.ts
// ─────────────────────────────────────────────────────────────
//  Shared types for the RWA Oracle Feeder (PRODUCTION)
// ─────────────────────────────────────────────────────────────

export interface SourcePrice {
  source: string;       // "goldapi" | "metalpriceapi" | "metalsdev" | "alphavantage"
  assetId: string;      // matches on-chain asset_id felt252
  price: number;        // USD, human-readable (e.g. 3248.50)
  timestamp: number;    // Unix seconds
}

export interface AggregatedPrice {
  assetId: string;
  medianPrice: number;
  sources: SourcePrice[];
  timestamp: number;
}

/** Result returned by OracleSubmitter.submitPrices() — one per asset */
export interface SubmitResult {
  assetId:      string;
  medianPrice:  number;
  sourceCount:  number;
  sources:      string[];       // source names
  onChainPrice: string;         // bigint as string (u256 on-chain)
  timestamp:    number;         // unix seconds
  txHash?:      string;
  blockNumber?: number;
  status:       "CONFIRMED" | "FAILED" | "PENDING";
  errorMessage?: string;
}

export interface AssetConfig {
  assetId: string;    // felt252 short string — must match on-chain
  symbol: string;     // human label, e.g. "XAU"
  decimals: number;   // on-chain decimal places
  assetType: string;  // felt252: 'COMMODITY', 'REAL_ESTATE', 'EQUITY', etc.
}

// ── Asset Registry ────────────────────────────────────────────
export const ASSETS: AssetConfig[] = [
  // Precious metals
  { assetId: "XAU_USD",    symbol: "XAU",    decimals: 8, assetType: "COMMODITY" },
  { assetId: "XAG_USD",    symbol: "XAG",    decimals: 8, assetType: "COMMODITY" },
  { assetId: "XPT_USD",    symbol: "XPT",    decimals: 8, assetType: "COMMODITY" },
  { assetId: "XPD_USD",    symbol: "XPD",    decimals: 8, assetType: "COMMODITY" },

  // Energy commodities
  { assetId: "WTI_USD",    symbol: "WTI",    decimals: 8, assetType: "COMMODITY" },
  { assetId: "BRENT_USD",  symbol: "BRENT",  decimals: 8, assetType: "COMMODITY" },
  { assetId: "NATGAS_USD", symbol: "NATGAS", decimals: 8, assetType: "COMMODITY" },

  // Industrial metals
  { assetId: "COPPER_USD", symbol: "COPPER", decimals: 8, assetType: "COMMODITY" },
  { assetId: "ALUM_USD",   symbol: "ALUM",   decimals: 8, assetType: "COMMODITY" },

  // Agricultural
  { assetId: "WHEAT_USD",  symbol: "WHEAT",  decimals: 8, assetType: "COMMODITY" },
  { assetId: "CORN_USD",   symbol: "CORN",   decimals: 8, assetType: "COMMODITY" },

  // Macro
  { assetId: "US_CPI",     symbol: "CPI",    decimals: 4, assetType: "MACRO" },
  { assetId: "US_INFL",    symbol: "INFL",   decimals: 4, assetType: "MACRO" },
  { assetId: "FED_RATE",   symbol: "FFR",    decimals: 4, assetType: "MACRO" },
  { assetId: "US_10YR",    symbol: "10YR",   decimals: 4, assetType: "MACRO" },
];
