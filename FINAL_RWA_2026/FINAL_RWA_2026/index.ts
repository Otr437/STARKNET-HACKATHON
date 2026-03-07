/**
 * ============================================================
 *  Starknet RWA — Macro-Economic Oracle Publisher
 *
 *  Off-chain service that:
 *    1. Fetches live CPI data from US BLS Public Data API v2
 *       Series: CUUR0000SA0 (CPI-U, All Urban Consumers, All Items)
 *    2. Fetches T-Bill rates from FRED API
 *       Series: TB3MS (3-Month), DGS10 (10-Year), FEDFUNDS
 *    3. Signs the data payload with publisher private key (Starknet ECDSA)
 *    4. Calls InflationOracle.publish_data() on Starknet
 *    5. Schedules: runs every 6 hours, retries on failure
 *
 *  Run:  npx ts-node index.ts
 *  Env:  See .env.example
 * ============================================================
 */

import * as dotenv from "dotenv";
import {
  Account,
  Contract,
  RpcProvider,
  json,
  hash,
  num,
  ec,
  CallData,
  uint256,
  shortString,
} from "starknet";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

dotenv.config();

// -------------------------------------------------------
//  Configuration & Environment
// -------------------------------------------------------
const CONFIG = {
  // Starknet
  STARKNET_RPC_URL:
    process.env.STARKNET_RPC_URL || "https://starknet-mainnet.public.blastapi.io/rpc/v0_7",
  PUBLISHER_ADDRESS: process.env.PUBLISHER_ADDRESS || "",
  PUBLISHER_PRIVATE_KEY: process.env.PUBLISHER_PRIVATE_KEY || "",
  ORACLE_CONTRACT_ADDRESS: process.env.ORACLE_CONTRACT_ADDRESS || "",

  // US BLS API - https://www.bls.gov/developers/api_signature_v2.htm
  BLS_API_KEY: process.env.BLS_API_KEY || "",        // register free at bls.gov/developers
  BLS_API_BASE: "https://api.bls.gov/publicAPI/v2",
  BLS_CPI_SERIES: "CUUR0000SA0",                     // CPI-U, US City Average, All Items, NSA

  // FRED API - https://fred.stlouisfed.org/docs/api/fred/
  FRED_API_KEY: process.env.FRED_API_KEY || "",      // register free at fred.stlouisfed.org
  FRED_API_BASE: "https://api.stlouisfed.org/fred",
  FRED_TBILL_3M: "TB3MS",                            // 3-Month T-Bill Secondary Market Rate
  FRED_TBILL_10Y: "DGS10",                           // 10-Year Treasury Constant Maturity
  FRED_FED_FUNDS: "FEDFUNDS",                        // Federal Funds Effective Rate

  // Metals-API - https://metals-api.com (FREE tier: 50 requests/month)
  METALS_API_KEY: process.env.METALS_API_KEY || "",
  METALS_API_BASE: "https://metals-api.com/api",

  // Alpha Vantage - https://www.alphavantage.co (FREE tier: 25 requests/day)
  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY || "",
  ALPHA_VANTAGE_BASE: "https://www.alphavantage.co/query",

  // Polygon.io - https://polygon.io (PAID, but has free tier with delayed data)
  POLYGON_API_KEY: process.env.POLYGON_API_KEY || "",
  POLYGON_API_BASE: "https://api.polygon.io",

  // CoinGecko - https://www.coingecko.com (FREE, no key needed for basic)
  COINGECKO_API_BASE: "https://api.coingecko.com/api/v3",

  // Scheduler
  PUBLISH_INTERVAL_MS: 6 * 60 * 60 * 1000,          // 6 hours
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 30_000,

  // Staleness — don't republish if data is same as last round
  FORCE_PUBLISH: process.env.FORCE_PUBLISH === "true",
};

// -------------------------------------------------------
//  Type Definitions
// -------------------------------------------------------
interface MacroData {
  cpi_value: number;          // e.g. 314.12 — raw BLS index value
  cpi_yoy_pct: number;        // e.g. 2.7 — year-over-year % change
  tbill_3m_pct: number;       // e.g. 5.30 — annualized %
  tbill_10y_pct: number;      // e.g. 4.60 — annualized %
  fed_funds_pct: number;      // e.g. 5.25 — upper target %
  data_timestamp: number;     // unix seconds of source data date
  source_dates: {
    cpi: string;
    tbill_3m: string;
    tbill_10y: string;
    fed_funds: string;
  };
}

interface AssetPrices {
  // Precious Metals ($/oz)
  gold_usd: number;           // XAU spot price
  silver_usd: number;         // XAG spot price
  platinum_usd: number;       // XPT spot price
  palladium_usd: number;      // XPD spot price
  
  // Stocks ($ per share)
  aapl_usd: number;           // Apple Inc
  msft_usd: number;           // Microsoft
  googl_usd: number;          // Google
  spx_usd: number;            // S&P 500 Index
  
  // Commodities
  oil_wti_usd: number;        // WTI Crude ($/barrel)
  oil_brent_usd: number;      // Brent Crude ($/barrel)
  
  timestamp: number;
}

interface OnChainParams {
  cpi_value_1e2: bigint;      // cpi * 100, e.g. 31412n
  cpi_yoy_bps: bigint;        // yoy * 100, e.g. 270n
  tbill_3m_bps: bigint;       // rate * 100, e.g. 530n
  tbill_10y_bps: bigint;
  fed_funds_bps: bigint;
  data_timestamp: bigint;     // unix seconds
}

interface PublishResult {
  success: boolean;
  tx_hash?: string;
  round_id?: bigint;
  error?: string;
  data?: MacroData;
}

// -------------------------------------------------------
//  HTTP Helper — fetch JSON over HTTPS without axios
// -------------------------------------------------------
function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": "Starknet-RWA-Oracle/1.0" } }, (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(new Error(`JSON parse error: ${e}`));
          }
        });
      })
      .on("error", reject);
  });
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "User-Agent": "Starknet-RWA-Oracle/1.0",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e}`));
        }
      });
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// -------------------------------------------------------
//  BLS CPI Fetcher
//  Uses BLS Public Data API v2:
//  POST https://api.bls.gov/publicAPI/v2/timeseries/data/
//  With registered API key for higher rate limits (50/day vs 10)
// -------------------------------------------------------
async function fetchCPIData(): Promise<{
  latest: number;
  previous_year: number;
  latest_date: string;
}> {
  console.log("[BLS] Fetching CPI-U data...");

  const currentYear = new Date().getFullYear();
  const payload = {
    seriesid: [CONFIG.BLS_CPI_SERIES],
    startyear: (currentYear - 2).toString(),
    endyear: currentYear.toString(),
    ...(CONFIG.BLS_API_KEY && { registrationkey: CONFIG.BLS_API_KEY }),
    annualaverage: false,
  };

  interface BLSResponse {
    status: string;
    Results: {
      series: Array<{
        seriesID: string;
        data: Array<{
          year: string;
          period: string;
          periodName: string;
          value: string;
          footnotes: Array<{ code: string; text: string }>;
        }>;
      }>;
    };
    message?: string[];
  }

  const response = await postJson<BLSResponse>(
    `${CONFIG.BLS_API_BASE}/timeseries/data/`,
    payload
  );

  if (response.status !== "REQUEST_SUCCEEDED") {
    throw new Error(`BLS API error: ${response.message?.join(", ") || "unknown error"}`);
  }

  const series = response.Results.series[0];
  if (!series || series.data.length === 0) {
    throw new Error("BLS: no data returned");
  }

  // Data comes in descending order (most recent first)
  // Filter out preliminary data (footnote code 'P')
  const finalData = series.data.filter(
    (d) => !d.footnotes.some((f) => f.code === "P")
  );

  if (finalData.length < 13) {
    throw new Error(`BLS: insufficient historical data (${finalData.length} points)`);
  }

  const latest = finalData[0];
  const prevYear = finalData[12]; // 12 months prior

  const latestValue = parseFloat(latest.value);
  const prevYearValue = parseFloat(prevYear.value);

  // BLS period format: M01-M12 for monthly
  const monthStr = latest.period.replace("M", "");
  const latestDate = `${latest.year}-${monthStr.padStart(2, "0")}-01`;

  console.log(
    `[BLS] CPI: ${latestValue} (${latestDate}), prev year: ${prevYearValue}`
  );

  return {
    latest: latestValue,
    previous_year: prevYearValue,
    latest_date: latestDate,
  };
}

// -------------------------------------------------------
//  FRED Rate Fetcher
//  Uses FRED REST API:
//  GET https://api.stlouisfed.org/fred/series/observations
//    ?series_id=TB3MS&api_key=...&file_type=json&limit=2&sort_order=desc
// -------------------------------------------------------
async function fetchFREDSeries(seriesId: string): Promise<{
  value: number;
  date: string;
}> {
  if (!CONFIG.FRED_API_KEY) {
    throw new Error("FRED_API_KEY required. Register at https://fred.stlouisfed.org/docs/api/api_key.html");
  }

  const url =
    `${CONFIG.FRED_API_BASE}/series/observations` +
    `?series_id=${seriesId}` +
    `&api_key=${CONFIG.FRED_API_KEY}` +
    `&file_type=json` +
    `&limit=5` +
    `&sort_order=desc`;

  interface FREDResponse {
    realtime_start: string;
    realtime_end: string;
    observation_start: string;
    observation_end: string;
    units: string;
    output_type: number;
    file_type: string;
    order_by: string;
    sort_order: string;
    count: number;
    offset: number;
    limit: number;
    observations: Array<{ date: string; value: string }>;
    error_code?: number;
    error_message?: string;
  }

  const response = await fetchJson<FREDResponse>(url);

  if (response.error_message) {
    throw new Error(`FRED API error [${seriesId}]: ${response.error_message}`);
  }

  // Find most recent non-missing value (FRED uses '.' for missing)
  const validObs = response.observations.filter((o) => o.value !== ".");
  if (validObs.length === 0) {
    throw new Error(`FRED: no valid data for ${seriesId}`);
  }

  const latest = validObs[0];
  const value = parseFloat(latest.value);

  console.log(`[FRED] ${seriesId}: ${value}% (${latest.date})`);

  return { value, date: latest.date };
}

// -------------------------------------------------------
//  Fetch Metal Prices from Metals-API
//  https://metals-api.com/documentation
// -------------------------------------------------------
async function fetchMetalPrices(): Promise<{
  gold: number;
  silver: number;
  platinum: number;
  palladium: number;
  date: string;
}> {
  if (!CONFIG.METALS_API_KEY) {
    console.warn('[Metals-API] No API key - skipping metals data');
    return { gold: 0, silver: 0, platinum: 0, palladium: 0, date: new Date().toISOString() };
  }

  const url = `${CONFIG.METALS_API_BASE}/latest?access_key=${CONFIG.METALS_API_KEY}&base=USD&symbols=XAU,XAG,XPT,XPD`;

  interface MetalsResponse {
    success: boolean;
    timestamp: number;
    base: string;
    date: string;
    rates: {
      XAU: number;  // USD per troy ounce gold
      XAG: number;  // USD per troy ounce silver
      XPT: number;  // USD per troy ounce platinum
      XPD: number;  // USD per troy ounce palladium
    };
    error?: {
      code: number;
      info: string;
    };
  }

  const response = await fetchJson<MetalsResponse>(url);

  if (!response.success || response.error) {
    throw new Error(`Metals-API error: ${response.error?.info || 'Unknown'}`);
  }

  // Metals-API returns "1 USD = X troy oz", we want "1 troy oz = $Y"
  const gold = 1 / response.rates.XAU;
  const silver = 1 / response.rates.XAG;
  const platinum = 1 / response.rates.XPT;
  const palladium = 1 / response.rates.XPD;

  console.log(`[Metals-API] Gold: $${gold.toFixed(2)}/oz, Silver: $${silver.toFixed(2)}/oz (${response.date})`);

  return { gold, silver, platinum, palladium, date: response.date };
}

// -------------------------------------------------------
//  Fetch Stock Prices from Alpha Vantage
//  https://www.alphavantage.co/documentation/
// -------------------------------------------------------
async function fetchStockPrice(symbol: string): Promise<{ price: number; date: string }> {
  if (!CONFIG.ALPHA_VANTAGE_KEY) {
    console.warn(`[Alpha Vantage] No API key - skipping ${symbol}`);
    return { price: 0, date: new Date().toISOString() };
  }

  const url = `${CONFIG.ALPHA_VANTAGE_BASE}?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${CONFIG.ALPHA_VANTAGE_KEY}`;

  interface AlphaVantageResponse {
    'Global Quote': {
      '01. symbol': string;
      '05. price': string;
      '07. latest trading day': string;
    };
    'Error Message'?: string;
    'Note'?: string;  // Rate limit message
  }

  const response = await fetchJson<AlphaVantageResponse>(url);

  if (response['Error Message']) {
    throw new Error(`Alpha Vantage error: ${response['Error Message']}`);
  }

  if (response['Note']) {
    throw new Error(`Alpha Vantage rate limit: ${response['Note']}`);
  }

  const quote = response['Global Quote'];
  if (!quote || !quote['05. price']) {
    throw new Error(`Alpha Vantage: no data for ${symbol}`);
  }

  const price = parseFloat(quote['05. price']);
  const date = quote['07. latest trading day'];

  console.log(`[Alpha Vantage] ${symbol}: $${price.toFixed(2)} (${date})`);

  return { price, date };
}

// -------------------------------------------------------
//  Fetch Oil Prices from Polygon.io or FRED fallback
// -------------------------------------------------------
async function fetchOilPrices(): Promise<{ wti: number; brent: number; date: string }> {
  // Use FRED for oil prices (free, reliable)
  // WTI: DCOILWTICO, Brent: DCOILBRENTEU
  try {
    const [wti, brent] = await Promise.all([
      fetchFREDSeries('DCOILWTICO'),
      fetchFREDSeries('DCOILBRENTEU'),
    ]);

    console.log(`[FRED] WTI: $${wti.value.toFixed(2)}/barrel, Brent: $${brent.value.toFixed(2)}/barrel`);

    return {
      wti: wti.value,
      brent: brent.value,
      date: wti.date,
    };
  } catch (error) {
    console.warn('[Oil Prices] Failed to fetch:', error);
    return { wti: 0, brent: 0, date: new Date().toISOString() };
  }
}

// -------------------------------------------------------
//  Aggregate all RWA asset prices
// -------------------------------------------------------
async function fetchAllAssetPrices(): Promise<AssetPrices> {
  console.log('\n[Oracle] Fetching RWA asset prices...');

  const [metals, oil] = await Promise.all([
    fetchMetalPrices(),
    fetchOilPrices(),
  ]);

  // Fetch stocks sequentially to avoid Alpha Vantage rate limit (5 req/min)
  let aapl = { price: 0, date: '' };
  let msft = { price: 0, date: '' };
  let googl = { price: 0, date: '' };
  let spx = { price: 0, date: '' };

  if (CONFIG.ALPHA_VANTAGE_KEY) {
    try {
      aapl = await fetchStockPrice('AAPL');
      await sleep(15000); // 15 sec between requests
      msft = await fetchStockPrice('MSFT');
      await sleep(15000);
      googl = await fetchStockPrice('GOOGL');
      await sleep(15000);
      // SPX requires different endpoint - skip for now
    } catch (error) {
      console.warn('[Stocks] Error fetching:', error);
    }
  }

  return {
    gold_usd: metals.gold,
    silver_usd: metals.silver,
    platinum_usd: metals.platinum,
    palladium_usd: metals.palladium,
    aapl_usd: aapl.price,
    msft_usd: msft.price,
    googl_usd: googl.price,
    spx_usd: spx.price,
    oil_wti_usd: oil.wti,
    oil_brent_usd: oil.brent,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------------------------------------------
//  Aggregate all macro data
// -------------------------------------------------------
async function fetchAllMacroData(): Promise<MacroData> {
  console.log("\n[Oracle] Fetching macro data...");

  const [cpiData, tbill3m, tbill10y, fedFunds] = await Promise.all([
    fetchCPIData(),
    fetchFREDSeries(CONFIG.FRED_TBILL_3M),
    fetchFREDSeries(CONFIG.FRED_TBILL_10Y),
    fetchFREDSeries(CONFIG.FRED_FED_FUNDS),
  ]);

  // Calculate YoY CPI change
  const cpiYoY =
    ((cpiData.latest - cpiData.previous_year) / cpiData.previous_year) * 100;

  // Most recent data date (use CPI date as canonical)
  const dataDate = new Date(cpiData.latest_date + "T00:00:00Z");
  const dataTimestamp = Math.floor(dataDate.getTime() / 1000);

  const result: MacroData = {
    cpi_value: cpiData.latest,
    cpi_yoy_pct: cpiYoY,
    tbill_3m_pct: tbill3m.value,
    tbill_10y_pct: tbill10y.value,
    fed_funds_pct: fedFunds.value,
    data_timestamp: dataTimestamp,
    source_dates: {
      cpi: cpiData.latest_date,
      tbill_3m: tbill3m.date,
      tbill_10y: tbill10y.date,
      fed_funds: fedFunds.date,
    },
  };

  console.log("\n[Oracle] Macro data snapshot:");
  console.log(`  CPI (CUUR0000SA0): ${result.cpi_value}`);
  console.log(`  CPI YoY:           ${result.cpi_yoy_pct.toFixed(2)}%`);
  console.log(`  T-Bill 3M:         ${result.tbill_3m_pct.toFixed(2)}%`);
  console.log(`  Treasury 10Y:      ${result.tbill_10y_pct.toFixed(2)}%`);
  console.log(`  Fed Funds:         ${result.fed_funds_pct.toFixed(2)}%`);
  console.log(`  Data Date:         ${cpiData.latest_date}`);

  return result;
}

// -------------------------------------------------------
//  Convert human-readable values to on-chain format
// -------------------------------------------------------
function toOnChainParams(data: MacroData): OnChainParams {
  // CPI: stored as integer * 100 (e.g., 314.12 → 31412)
  const cpi_value_1e2 = BigInt(Math.round(data.cpi_value * 100));

  // Rates: stored in basis points (1% = 100 bps)
  const cpi_yoy_bps = BigInt(Math.round(data.cpi_yoy_pct * 100));
  const tbill_3m_bps = BigInt(Math.round(data.tbill_3m_pct * 100));
  const tbill_10y_bps = BigInt(Math.round(data.tbill_10y_pct * 100));
  const fed_funds_bps = BigInt(Math.round(data.fed_funds_pct * 100));

  return {
    cpi_value_1e2,
    cpi_yoy_bps,
    tbill_3m_bps,
    tbill_10y_bps,
    fed_funds_bps,
    data_timestamp: BigInt(data.data_timestamp),
  };
}

// -------------------------------------------------------
//  Sign payload for Starknet
//  msg_hash = pedersen(cpi || tbill_3m || tbill_10y || fed_funds || data_ts)
// -------------------------------------------------------
function signPayload(
  params: OnChainParams,
  privateKey: string
): { r: bigint; s: bigint } {
  // Compute message hash using Poseidon (MUST match on-chain verification)
  const msgHash = hash.computePoseidonHashOnElements([
    params.cpi_value_1e2.toString(),
    params.cpi_yoy_bps.toString(),
    params.tbill_3m_bps.toString(),
    params.tbill_10y_bps.toString(),
    params.fed_funds_bps.toString(),
    params.data_timestamp.toString(),
    CONFIG.PUBLISHER_ADDRESS, // Include publisher address in hash
  ]);

  const sig = ec.starkCurve.sign(msgHash, privateKey);

  return {
    r: BigInt(sig.r.toString()),
    s: BigInt(sig.s.toString()),
  };
}

// -------------------------------------------------------
//  Load oracle contract ABI
// -------------------------------------------------------
function loadOracleABI(): object[] {
  const abiPath = path.join(__dirname, "../cairo/artifacts/inflation_oracle_abi.json");
  if (fs.existsSync(abiPath)) {
    return JSON.parse(fs.readFileSync(abiPath, "utf-8")) as object[];
  }
  // Minimal inline ABI if compiled artifact not present
  return [
    {
      type: "function",
      name: "publish_data",
      inputs: [
        { name: "cpi_value", type: "core::integer::u128" },
        { name: "cpi_yoy_bps", type: "core::integer::u128" },
        { name: "tbill_3m_bps", type: "core::integer::u128" },
        { name: "tbill_10y_bps", type: "core::integer::u128" },
        { name: "fed_funds_bps", type: "core::integer::u128" },
        { name: "data_timestamp", type: "core::integer::u64" },
        { name: "signature_r", type: "core::felt252" },
        { name: "signature_s", type: "core::felt252" },
      ],
      outputs: [],
      state_mutability: "external",
    },
    {
      type: "function",
      name: "get_cpi",
      inputs: [],
      outputs: [
        {
          type: "starknet_rwa::interfaces::MacroDataPoint",
        },
      ],
      state_mutability: "view",
    },
    {
      type: "function",
      name: "get_latest_round_id",
      inputs: [],
      outputs: [{ type: "core::integer::u64" }],
      state_mutability: "view",
    },
    {
      type: "function",
      name: "is_data_fresh",
      inputs: [],
      outputs: [{ type: "core::bool" }],
      state_mutability: "view",
    },
  ];
}

// -------------------------------------------------------
//  Publish to Starknet
// -------------------------------------------------------
async function publishToStarknet(
  params: OnChainParams,
  signature: { r: bigint; s: bigint }
): Promise<string> {
  const provider = new RpcProvider({ nodeUrl: CONFIG.STARKNET_RPC_URL });

  const account = new Account(
    provider,
    CONFIG.PUBLISHER_ADDRESS,
    CONFIG.PUBLISHER_PRIVATE_KEY
  );

  const abi = loadOracleABI();
  const oracle = new Contract(abi, CONFIG.ORACLE_CONTRACT_ADDRESS, provider);
  oracle.connect(account);

  console.log("\n[Starknet] Submitting oracle update...");
  console.log(`  Contract: ${CONFIG.ORACLE_CONTRACT_ADDRESS}`);
  console.log(`  Publisher: ${CONFIG.PUBLISHER_ADDRESS}`);

  const calldata = CallData.compile({
    cpi_value: params.cpi_value_1e2.toString(),
    cpi_yoy_bps: params.cpi_yoy_bps.toString(),
    tbill_3m_bps: params.tbill_3m_bps.toString(),
    tbill_10y_bps: params.tbill_10y_bps.toString(),
    fed_funds_bps: params.fed_funds_bps.toString(),
    data_timestamp: params.data_timestamp.toString(),
    signature_r: num.toHex(signature.r),
    signature_s: num.toHex(signature.s),
  });

  const { transaction_hash } = await account.execute({
    contractAddress: CONFIG.ORACLE_CONTRACT_ADDRESS,
    entrypoint: "publish_data",
    calldata,
  });

  console.log(`[Starknet] Tx submitted: ${transaction_hash}`);

  // Wait for inclusion
  const receipt = await provider.waitForTransaction(transaction_hash);
  if (receipt.isSuccess()) {
    console.log(`[Starknet] ✅ Transaction confirmed in block ${receipt.block_number}`);
  } else {
    throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
  }

  return transaction_hash;
}

// -------------------------------------------------------
//  Main publish cycle with retry
// -------------------------------------------------------
async function publishCycle(): Promise<PublishResult> {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`[Oracle Publisher] Cycle start — attempt ${attempt}/${CONFIG.MAX_RETRIES}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
      console.log("=".repeat(60));

      // 1. Fetch real-world data
      const macroData = await fetchAllMacroData();
      
      // 1b. Fetch RWA asset prices
      const assetPrices = await fetchAllAssetPrices();
      
      // Save asset prices to backend API for frontend display
      try {
        const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:3001';
        await fetch(`${backendUrl}/api/prices/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(assetPrices),
        });
        console.log('[Backend] Asset prices saved to API');
      } catch (apiError) {
        console.warn('[Backend] Failed to save prices to API:', apiError);
        // Continue - this is not critical for oracle publishing
      }

      // 2. Convert to on-chain format
      const onChainParams = toOnChainParams(macroData);

      console.log("\n[Oracle] On-chain encoding:");
      console.log(`  cpi_value_1e2:  ${onChainParams.cpi_value_1e2}`);
      console.log(`  cpi_yoy_bps:    ${onChainParams.cpi_yoy_bps}`);
      console.log(`  tbill_3m_bps:   ${onChainParams.tbill_3m_bps}`);
      console.log(`  tbill_10y_bps:  ${onChainParams.tbill_10y_bps}`);
      console.log(`  fed_funds_bps:  ${onChainParams.fed_funds_bps}`);
      console.log(`  data_timestamp: ${onChainParams.data_timestamp}`);

      // 3. Sign payload
      const signature = signPayload(onChainParams, CONFIG.PUBLISHER_PRIVATE_KEY);
      console.log(`\n[Signing] r: ${num.toHex(signature.r).slice(0, 16)}...`);

      // 4. Publish to Starknet
      const txHash = await publishToStarknet(onChainParams, signature);

      return {
        success: true,
        tx_hash: txHash,
        data: macroData,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`\n[Oracle] ❌ Attempt ${attempt} failed: ${errMsg}`);

      if (attempt < CONFIG.MAX_RETRIES) {
        console.log(`[Oracle] Retrying in ${CONFIG.RETRY_DELAY_MS / 1000}s...`);
        await sleep(CONFIG.RETRY_DELAY_MS);
      } else {
        return { success: false, error: errMsg };
      }
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

// -------------------------------------------------------
//  Dry run — fetch and display data without submitting tx
// -------------------------------------------------------
async function dryRun(): Promise<void> {
  console.log("🔍 DRY RUN MODE — data will be fetched but not submitted\n");

  const macroData = await fetchAllMacroData();
  const onChainParams = toOnChainParams(macroData);

  console.log("\n📊 On-chain encoded values:");
  console.log(`  CPI Index (1e2):    ${onChainParams.cpi_value_1e2}`);
  console.log(`  CPI YoY (bps):      ${onChainParams.cpi_yoy_bps} = ${Number(onChainParams.cpi_yoy_bps) / 100}%`);
  console.log(`  T-Bill 3M (bps):    ${onChainParams.tbill_3m_bps} = ${Number(onChainParams.tbill_3m_bps) / 100}%`);
  console.log(`  Treasury 10Y (bps): ${onChainParams.tbill_10y_bps} = ${Number(onChainParams.tbill_10y_bps) / 100}%`);
  console.log(`  Fed Funds (bps):    ${onChainParams.fed_funds_bps} = ${Number(onChainParams.fed_funds_bps) / 100}%`);
  console.log(`  Data timestamp:     ${onChainParams.data_timestamp} = ${new Date(Number(onChainParams.data_timestamp) * 1000).toISOString()}`);

  if (CONFIG.PUBLISHER_PRIVATE_KEY) {
    const sig = signPayload(onChainParams, CONFIG.PUBLISHER_PRIVATE_KEY);
    console.log(`\n🔐 Signature:`);
    console.log(`  r: ${num.toHex(sig.r)}`);
    console.log(`  s: ${num.toHex(sig.s)}`);
  } else {
    console.log("\n⚠️  No PUBLISHER_PRIVATE_KEY set — skipping signature");
  }
}

// -------------------------------------------------------
//  Scheduler
// -------------------------------------------------------
async function runScheduler(): Promise<void> {
  console.log("🚀 Starknet RWA Macro-Economic Oracle Publisher");
  console.log(`   Publish interval: ${CONFIG.PUBLISH_INTERVAL_MS / 3600000}h`);
  console.log(`   Oracle contract:  ${CONFIG.ORACLE_CONTRACT_ADDRESS}`);
  console.log(`   Publisher:        ${CONFIG.PUBLISHER_ADDRESS}\n`);

  // Immediate first run
  const result = await publishCycle();
  if (result.success) {
    console.log(`\n✅ Published: ${result.tx_hash}`);
  } else {
    console.error(`\n❌ Failed: ${result.error}`);
  }

  // Schedule recurring
  setInterval(async () => {
    const result = await publishCycle();
    if (result.success) {
      console.log(`\n✅ Published: ${result.tx_hash}`);
    } else {
      console.error(`\n❌ Failed: ${result.error}`);
    }
  }, CONFIG.PUBLISH_INTERVAL_MS);
}

// -------------------------------------------------------
//  Helpers
// -------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateConfig(): void {
  const required = ["PUBLISHER_ADDRESS", "PUBLISHER_PRIVATE_KEY", "ORACLE_CONTRACT_ADDRESS"];
  for (const key of required) {
    if (!CONFIG[key as keyof typeof CONFIG]) {
      console.error(`❌ Missing required env var: ${key}`);
      console.error("   See .env.example for configuration");
      process.exit(1);
    }
  }

  if (!CONFIG.FRED_API_KEY) {
    console.warn("⚠️  FRED_API_KEY not set — FRED requests may be rate limited");
    console.warn("   Register at: https://fred.stlouisfed.org/docs/api/api_key.html");
  }
}

// -------------------------------------------------------
//  Entry Point
// -------------------------------------------------------
const command = process.argv[2];

if (command === "dry-run") {
  dryRun().catch(console.error);
} else if (command === "once") {
  validateConfig();
  publishCycle().then((r) => {
    if (!r.success) process.exit(1);
  });
} else {
  validateConfig();
  runScheduler().catch(console.error);
}

export { fetchAllMacroData, toOnChainParams, publishCycle, dryRun };
