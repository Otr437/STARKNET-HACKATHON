/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:24
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  348E8EDC246D2F04DA55E45BEFE8AC0A90CAF31A50DFB8D4FE57DADC23A9A697
SHA-512:  921B212869B0E6611971E4403B26782B4793A648701629E407DEF87A63FA9E1BA5DFC280B622632A809AC79DAF3B97F35BCE2100FF3E84C94CDEE1283CE660AD
MD5:      BA4655D6CFE300B52B268B596BE88FA1
File Size: 30716 bytes

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
/**
 * ============================================================
 *  Starknet RWA — Macro-Economic Oracle Publisher
 *
 *  Fetches real data from:
 *    US BLS API v2  → CUUR0000SA0 (CPI-U All Items NSA)
 *    FRED API       → TB3MS, DGS10, FEDFUNDS
 *
 *  Converts to on-chain format that matches InflationOracle.cairo:
 *    CPI stored as integer * 100    (314.856 → 31486)
 *    Rates stored as basis points   (5.25%   → 525)
 *
 *  Signs with publisher ECDSA key (Starknet stark_curve)
 *  Publishes to InflationOracle.cairo via publish_data()
 *  Tracks last published round to avoid redundant transactions
 *
 *  Run:
 *    npx ts-node index.ts              — runs every 6 hours
 *    npx ts-node index.ts once         — single publish
 *    npx ts-node index.ts dry-run      — fetch + encode + sign, no tx
 *    npx ts-node index.ts check        — show current on-chain state
 * ============================================================
 */

import * as dotenv from 'dotenv';
import {
  Account,
  Contract,
  RpcProvider,
  hash,
  num,
  ec,
  CallData,
} from 'starknet';
import * as https from 'https';
import * as fs    from 'fs';
import * as path  from 'path';

dotenv.config();

// ─────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  STARKNET_RPC_URL:    process.env.STARKNET_RPC_URL    || 'https://starknet-mainnet.public.blastapi.io/rpc/v0_7',
  PUBLISHER_ADDRESS:   process.env.PUBLISHER_ADDRESS   || '',
  PUBLISHER_PRIVATE_KEY: process.env.PUBLISHER_PRIVATE_KEY || '',
  ORACLE_CONTRACT_ADDRESS: process.env.ORACLE_CONTRACT_ADDRESS || '',

  BLS_API_KEY:  process.env.BLS_API_KEY  || '',
  FRED_API_KEY: process.env.FRED_API_KEY || '',

  // BLS series: CPI-U All Urban Consumers, All Items, NSA
  BLS_SERIES: 'CUUR0000SA0',

  // FRED series
  FRED_TBILL_3M:  'TB3MS',    // 3-Month T-Bill Secondary Market Rate
  FRED_TBILL_10Y: 'DGS10',    // 10-Year Treasury Constant Maturity
  FRED_FED_FUNDS: 'FEDFUNDS', // Federal Funds Effective Rate

  PUBLISH_INTERVAL_MS: 6 * 60 * 60 * 1000, // 6 hours
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 60_000,

  // State file for tracking last published data (avoids duplicate txs)
  STATE_FILE: path.join(__dirname, '.publisher_state.json'),
};

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────
interface MacroData {
  // Human readable
  cpi:          number;   // e.g. 314.856
  yoy_pct:      number;   // e.g. 2.70
  tbill_3m_pct: number;   // e.g. 5.29
  tbill_10y_pct:number;   // e.g. 4.56
  fed_funds_pct:number;   // e.g. 5.33

  // Source provenance
  cpi_date:   string;
  cpi_period: string;
  t3m_date:   string;
  t10y_date:  string;
  ff_date:    string;
  fetched_at: string;
}

interface OnChainEncoded {
  // Exact values as InflationOracle.cairo expects them
  cpi_1e2:       bigint;  // CPI * 100, e.g. 31486n
  cpi_yoy_bps:   bigint;  // YoY % * 100 = bps, e.g. 270n
  tbill_3m_bps:  bigint;  // rate % * 100 = bps, e.g. 529n
  tbill_10y_bps: bigint;  // rate % * 100 = bps, e.g. 456n
  fed_funds_bps: bigint;  // rate % * 100 = bps, e.g. 533n
  data_timestamp:bigint;  // unix seconds of source data date
}

interface PublisherState {
  last_tx_hash:     string;
  last_round_id:    number;
  last_cpi_1e2:     number;
  last_published_at:string;
}

// ─────────────────────────────────────────────────────────────
//  HTTPS helpers
// ─────────────────────────────────────────────────────────────
function httpsPost<T>(hostname: string, urlPath: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      {
        hostname,
        port: 443,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent':     'RWA-OraclePublisher/1.0',
        },
      },
      res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${hostname}${urlPath}: ${buf.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(buf) as T); }
          catch (e) { reject(new Error(`JSON parse from ${hostname}: ${(e as Error).message}`)); }
        });
      }
    );
    req.on('error', e => reject(new Error(`Network error to ${hostname}: ${e.message}`)));
    req.write(data);
    req.end();
  });
}

function httpsGet<T>(hostname: string, urlPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: { 'User-Agent': 'RWA-OraclePublisher/1.0' },
      },
      res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${hostname}${urlPath}`));
            return;
          }
          try { resolve(JSON.parse(buf) as T); }
          catch (e) { reject(new Error(`JSON parse: ${(e as Error).message}`)); }
        });
      }
    );
    req.on('error', e => reject(new Error(`Network error: ${e.message}`)));
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
//  BLS CPI Fetch
//  POST https://api.bls.gov/publicAPI/v2/timeseries/data/
//
//  Series CUUR0000SA0:
//    - CPI-U = Consumer Price Index for All Urban Consumers
//    - All Items = not just food/energy
//    - Not Seasonally Adjusted (NSA) = raw number, no smoothing
//
//  BLS data release schedule: ~2 weeks after reference month end
//  e.g. December 2025 CPI released mid-January 2026
// ─────────────────────────────────────────────────────────────
interface BLSResponse {
  status: string;
  message?: string[];
  Results?: {
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
}

async function fetchBLS(): Promise<{ cpi: number; yoyPct: number; date: string; period: string }> {
  const year = new Date().getFullYear();
  const body: Record<string, unknown> = {
    seriesid:     [CONFIG.BLS_SERIES],
    startyear:    String(year - 2),
    endyear:      String(year),
    annualaverage: false,
  };
  if (CONFIG.BLS_API_KEY) body.registrationkey = CONFIG.BLS_API_KEY;

  console.log(`[BLS] POST api.bls.gov/publicAPI/v2/timeseries/data/ series=${CONFIG.BLS_SERIES}`);

  const json = await httpsPost<BLSResponse>('api.bls.gov', '/publicAPI/v2/timeseries/data/', body);

  if (json.status !== 'REQUEST_SUCCEEDED') {
    throw new Error(`BLS API failed: ${json.message?.join('; ') || 'unknown error'}`);
  }

  const rawData = json.Results?.series?.[0]?.data || [];
  if (!rawData.length) throw new Error('BLS: empty data array for ' + CONFIG.BLS_SERIES);

  // Exclude preliminary and annual-average data points
  const final = rawData.filter(d =>
    d.period !== 'M13' &&
    !d.footnotes?.some(f => f.code === 'P')
  );

  if (final.length < 13) {
    throw new Error(`BLS: only ${final.length} finalized monthly points (need ≥13 for YoY calculation)`);
  }

  // newest-first ordering from BLS
  const latest   = final[0];
  const prevYear = final[12];

  const cpi    = parseFloat(latest.value);
  const prev   = parseFloat(prevYear.value);
  if (isNaN(cpi) || isNaN(prev)) {
    throw new Error(`BLS: unparseable values: latest="${latest.value}" prev="${prevYear.value}"`);
  }

  const yoyPct = ((cpi - prev) / prev) * 100;
  const monthNum = latest.period.replace('M', '').padStart(2, '0');

  console.log(`[BLS] CPI: ${cpi.toFixed(3)} | YoY: ${yoyPct.toFixed(2)}% | Period: ${latest.periodName} ${latest.year}`);
  console.log(`[BLS] Previous year (${prevYear.periodName} ${prevYear.year}): ${prevYear.value}`);

  return {
    cpi,
    yoyPct,
    date:   `${latest.year}-${monthNum}-01`,
    period: `${latest.periodName} ${latest.year}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  FRED Series Fetch
//  GET https://api.stlouisfed.org/fred/series/observations
//
//  Returns rate as a percentage string e.g. "5.25"
//  We convert to basis points for on-chain storage: 5.25 → 525
// ─────────────────────────────────────────────────────────────
interface FREDResponse {
  observations?: Array<{ date: string; value: string }>;
  error_code?:   number;
  error_message?:string;
}

async function fetchFRED(series: string): Promise<{ value: number; date: string }> {
  if (!CONFIG.FRED_API_KEY) {
    throw new Error(`FRED_API_KEY not set. Required for ${series}. Register free at fred.stlouisfed.org`);
  }

  const fredPath = `/fred/series/observations` +
    `?series_id=${encodeURIComponent(series)}` +
    `&api_key=${encodeURIComponent(CONFIG.FRED_API_KEY)}` +
    `&file_type=json&limit=10&sort_order=desc`;

  console.log(`[FRED] GET api.stlouisfed.org${fredPath.split('&api_key')[0]}...`);

  const json = await httpsGet<FREDResponse>('api.stlouisfed.org', fredPath);

  if (json.error_message) {
    throw new Error(`FRED [${series}]: ${json.error_message}`);
  }

  const valid = (json.observations || [])
    .filter(o => o.value !== '.' && o.value !== '' && !isNaN(parseFloat(o.value)));

  if (!valid.length) {
    throw new Error(`FRED [${series}]: all recent observations are missing values`);
  }

  const value = parseFloat(valid[0].value);
  console.log(`[FRED] ${series}: ${value}% (${valid[0].date})`);

  return { value, date: valid[0].date };
}

// ─────────────────────────────────────────────────────────────
//  Fetch all macro data
// ─────────────────────────────────────────────────────────────
async function fetchAllMacroData(): Promise<MacroData> {
  console.log('\n' + '─'.repeat(60));
  console.log('[Oracle] Fetching all macro data (BLS + FRED in parallel)');
  console.log('─'.repeat(60));

  const [bls, t3m, t10y, ff] = await Promise.all([
    fetchBLS(),
    fetchFRED(CONFIG.FRED_TBILL_3M),
    fetchFRED(CONFIG.FRED_TBILL_10Y),
    fetchFRED(CONFIG.FRED_FED_FUNDS),
  ]);

  return {
    cpi:          bls.cpi,
    yoy_pct:      bls.yoyPct,
    tbill_3m_pct: t3m.value,
    tbill_10y_pct:t10y.value,
    fed_funds_pct:ff.value,
    cpi_date:     bls.date,
    cpi_period:   bls.period,
    t3m_date:     t3m.date,
    t10y_date:    t10y.date,
    ff_date:      ff.date,
    fetched_at:   new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
//  Encode for Starknet InflationOracle.cairo
//
//  InflationOracle.cairo storage format:
//    cpi_value     : u128 — CPI index * 100 (no decimals)
//                    314.856 → 31486
//    cpi_yoy_bps   : u128 — year-over-year in basis points
//                    2.70% → 270
//    tbill_3m_bps  : u128 — 3M T-Bill rate in basis points
//                    5.29% → 529
//    tbill_10y_bps : u128 — 10Y rate in basis points
//                    4.56% → 456
//    fed_funds_bps : u128 — Fed Funds rate in basis points
//                    5.33% → 533
//    data_timestamp: u64  — unix seconds of source data date
//                    "2025-12-01" → 1764547200
//
//  Starknet felt252 constraints:
//    All values must be < 2^251 (prime field element)
//    All values here are small integers, well within range
//    We pass them as decimal strings in calldata
// ─────────────────────────────────────────────────────────────
function encodeForOnChain(data: MacroData): OnChainEncoded {
  // CPI: multiply by 100 and round to integer
  // e.g. 314.856 * 100 = 31485.6 → 31486
  const cpi_1e2 = BigInt(Math.round(data.cpi * 100));

  // Rates: multiply by 100 to get basis points
  // e.g. 2.70% * 100 = 270.0 → 270 bps
  // e.g. -0.15% → still valid, floor at 0 for u128
  const cpi_yoy_bps   = BigInt(Math.max(0, Math.round(data.yoy_pct * 100)));
  const tbill_3m_bps  = BigInt(Math.max(0, Math.round(data.tbill_3m_pct * 100)));
  const tbill_10y_bps = BigInt(Math.max(0, Math.round(data.tbill_10y_pct * 100)));
  const fed_funds_bps = BigInt(Math.max(0, Math.round(data.fed_funds_pct * 100)));

  // data_timestamp: unix seconds from ISO date string of CPI release
  // e.g. "2025-12-01" → Date.parse → ms → / 1000
  const dateMs = Date.parse(data.cpi_date + 'T00:00:00Z');
  if (isNaN(dateMs)) throw new Error(`Cannot parse CPI date: "${data.cpi_date}"`);
  const data_timestamp = BigInt(Math.floor(dateMs / 1000));

  // Validate ranges against InflationOracle.cairo bounds:
  //   CPI: 100..99999 (1.00 to 999.99)
  //   Rates: 0..5000 (0% to 50%)
  //   YoY: 0..3000 (0% to 30%)
  if (cpi_1e2 < 100n || cpi_1e2 > 99999n) {
    throw new Error(`CPI out of oracle range [100, 99999]: got ${cpi_1e2} (raw: ${data.cpi})`);
  }
  if (tbill_3m_bps > 5000n)  throw new Error(`3M T-Bill ${tbill_3m_bps}bps exceeds oracle max 5000`);
  if (tbill_10y_bps > 5000n) throw new Error(`10Y rate ${tbill_10y_bps}bps exceeds oracle max 5000`);
  if (fed_funds_bps > 5000n) throw new Error(`Fed Funds ${fed_funds_bps}bps exceeds oracle max 5000`);
  if (cpi_yoy_bps > 3000n)   throw new Error(`YoY CPI ${cpi_yoy_bps}bps exceeds oracle max 3000`);

  return { cpi_1e2, cpi_yoy_bps, tbill_3m_bps, tbill_10y_bps, fed_funds_bps, data_timestamp };
}

// ─────────────────────────────────────────────────────────────
//  Sign payload for InflationOracle.cairo verify
//
//  Contract checks: signature_r != 0 && signature_s != 0
//  Full verification: pedersen hash of data fields, signed with
//  publisher's Starknet stark_curve ECDSA key
//
//  Message hash input (same order as contract verification):
//    [cpi_1e2, tbill_3m_bps, tbill_10y_bps, fed_funds_bps, data_timestamp]
// ─────────────────────────────────────────────────────────────
function signPayload(
  encoded: OnChainEncoded,
  privateKey: string
): { r: string; s: string; msgHash: string } {
  const msgHash = hash.computeHashOnElements([
    encoded.cpi_1e2.toString(),
    encoded.tbill_3m_bps.toString(),
    encoded.tbill_10y_bps.toString(),
    encoded.fed_funds_bps.toString(),
    encoded.data_timestamp.toString(),
  ]);

  const sig = ec.starkCurve.sign(msgHash, privateKey);

  // Convert to hex felt252 strings for Starknet calldata
  const r = num.toHex(BigInt(sig.r.toString()));
  const s = num.toHex(BigInt(sig.s.toString()));

  return { r, s, msgHash };
}

// ─────────────────────────────────────────────────────────────
//  Read current on-chain oracle state
// ─────────────────────────────────────────────────────────────
async function readOnChainState(provider: RpcProvider): Promise<{
  roundId: number;
  isFresh: boolean;
  baseCpi: number;
  pubCount: number;
}> {
  const call = (ep: string, cd: string[] = []) =>
    provider.callContract({
      contractAddress: CONFIG.ORACLE_CONTRACT_ADDRESS,
      entrypoint: ep,
      calldata: cd,
    }).then(r => (r.result || r) as string[]);

  const [roundR, freshR, baseR, pubR] = await Promise.all([
    call('get_latest_round_id'),
    call('is_data_fresh'),
    call('get_cpi_index_base'),
    call('get_publisher_count'),
  ]);

  return {
    roundId:  parseInt(roundR[0], 16),
    isFresh:  parseInt(freshR[0], 16) !== 0,
    baseCpi:  parseInt(baseR[0], 16),
    pubCount: parseInt(pubR[0], 16),
  };
}

// ─────────────────────────────────────────────────────────────
//  Persistent state (avoids re-publishing same data)
// ─────────────────────────────────────────────────────────────
function loadState(): PublisherState | null {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf-8')) as PublisherState;
    }
  } catch (_) {}
  return null;
}

function saveState(state: PublisherState): void {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[State] Could not save state file:', (e as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Publish to Starknet
// ─────────────────────────────────────────────────────────────
async function publishToStarknet(
  encoded: OnChainEncoded,
  sig: { r: string; s: string }
): Promise<{ txHash: string; roundId: number }> {
  const provider = new RpcProvider({ nodeUrl: CONFIG.STARKNET_RPC_URL });
  const account  = new Account(provider, CONFIG.PUBLISHER_ADDRESS, CONFIG.PUBLISHER_PRIVATE_KEY);

  // Build calldata — all values as decimal strings for felt252/u128/u64
  // Order must match InflationOracle.cairo publish_data() parameter list exactly:
  //   cpi_value, cpi_yoy_bps, tbill_3m_bps, tbill_10y_bps, fed_funds_bps,
  //   data_timestamp, signature_r, signature_s
  const calldata = CallData.compile({
    cpi_value:     encoded.cpi_1e2.toString(),
    cpi_yoy_bps:   encoded.cpi_yoy_bps.toString(),
    tbill_3m_bps:  encoded.tbill_3m_bps.toString(),
    tbill_10y_bps: encoded.tbill_10y_bps.toString(),
    fed_funds_bps: encoded.fed_funds_bps.toString(),
    data_timestamp:encoded.data_timestamp.toString(),
    signature_r:   sig.r,
    signature_s:   sig.s,
  });

  console.log(`\n[Starknet] Submitting publish_data() to ${CONFIG.ORACLE_CONTRACT_ADDRESS}`);
  console.log(`[Starknet] Publisher: ${CONFIG.PUBLISHER_ADDRESS}`);
  console.log('[Starknet] Calldata:');
  console.log(`  cpi_value      = ${encoded.cpi_1e2}  (${(Number(encoded.cpi_1e2)/100).toFixed(2)} CPI index)`);
  console.log(`  cpi_yoy_bps    = ${encoded.cpi_yoy_bps}  (${(Number(encoded.cpi_yoy_bps)/100).toFixed(2)}% YoY)`);
  console.log(`  tbill_3m_bps   = ${encoded.tbill_3m_bps}  (${(Number(encoded.tbill_3m_bps)/100).toFixed(2)}%)`);
  console.log(`  tbill_10y_bps  = ${encoded.tbill_10y_bps}  (${(Number(encoded.tbill_10y_bps)/100).toFixed(2)}%)`);
  console.log(`  fed_funds_bps  = ${encoded.fed_funds_bps}  (${(Number(encoded.fed_funds_bps)/100).toFixed(2)}%)`);
  console.log(`  data_timestamp = ${encoded.data_timestamp}  (${new Date(Number(encoded.data_timestamp)*1000).toISOString()})`);

  const { transaction_hash } = await account.execute({
    contractAddress: CONFIG.ORACLE_CONTRACT_ADDRESS,
    entrypoint:      'publish_data',
    calldata,
  });

  console.log(`[Starknet] TX submitted: ${transaction_hash}`);
  console.log('[Starknet] Waiting for inclusion...');

  const receipt = await provider.waitForTransaction(transaction_hash);

  if (!receipt.isSuccess || !receipt.isSuccess()) {
    throw new Error(`TX reverted: ${JSON.stringify((receipt as any).revert_reason || '')}`);
  }

  console.log(`[Starknet] ✅ Confirmed in block ${receipt.block_number}`);

  // Read new round ID
  const onChain = await readOnChainState(provider);
  return { txHash: transaction_hash, roundId: onChain.roundId };
}

// ─────────────────────────────────────────────────────────────
//  Main publish cycle
// ─────────────────────────────────────────────────────────────
async function publishCycle(skipDuplicateCheck = false): Promise<void> {
  // 1. Fetch real data
  const macroData = await fetchAllMacroData();

  // 2. Encode to on-chain format
  const encoded = encodeForOnChain(macroData);

  // 3. Check if we already published this exact CPI value recently
  const prevState = loadState();
  if (!skipDuplicateCheck && prevState) {
    if (prevState.last_cpi_1e2 === Number(encoded.cpi_1e2)) {
      const ageHrs = (Date.now() - Date.parse(prevState.last_published_at)) / 3600_000;
      if (ageHrs < 24) {
        console.log(`\n[Oracle] Skipping — CPI ${encoded.cpi_1e2} already published ${ageHrs.toFixed(1)}h ago`);
        console.log(`[Oracle] Last TX: ${prevState.last_tx_hash}`);
        console.log('[Oracle] Use `once --force` to override\n');
        return;
      }
    }
  }

  // 4. Sign
  console.log('\n[Signing] Computing pedersen hash of data fields...');
  const sig = signPayload(encoded, CONFIG.PUBLISHER_PRIVATE_KEY);
  console.log(`[Signing] msg_hash: ${sig.msgHash}`);
  console.log(`[Signing] r: ${sig.r.slice(0, 18)}...  s: ${sig.s.slice(0, 18)}...`);

  // 5. Submit tx
  const result = await publishToStarknet(encoded, sig);

  // 6. Save state
  saveState({
    last_tx_hash:     result.txHash,
    last_round_id:    result.roundId,
    last_cpi_1e2:     Number(encoded.cpi_1e2),
    last_published_at:new Date().toISOString(),
  });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅ PUBLISHED SUCCESSFULLY`);
  console.log(`  Round ID  : ${result.roundId}`);
  console.log(`  TX Hash   : ${result.txHash}`);
  console.log(`  CPI       : ${(Number(encoded.cpi_1e2)/100).toFixed(2)} (${macroData.cpi_period})`);
  console.log(`  YoY       : ${(Number(encoded.cpi_yoy_bps)/100).toFixed(2)}%`);
  console.log(`  3M T-Bill : ${(Number(encoded.tbill_3m_bps)/100).toFixed(2)}%`);
  console.log(`  10Y Treas : ${(Number(encoded.tbill_10y_bps)/100).toFixed(2)}%`);
  console.log(`  Fed Funds : ${(Number(encoded.fed_funds_bps)/100).toFixed(2)}%`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─────────────────────────────────────────────────────────────
//  Dry run — fetch + encode + sign, no tx
// ─────────────────────────────────────────────────────────────
async function dryRun(): Promise<void> {
  console.log('🔍 DRY RUN — no transaction will be submitted\n');

  const macroData = await fetchAllMacroData();
  const encoded   = encodeForOnChain(macroData);

  console.log('\n📊 Macro data:');
  console.log(`  CPI (CUUR0000SA0): ${macroData.cpi.toFixed(3)}  (${macroData.cpi_period})`);
  console.log(`  CPI YoY:           ${macroData.yoy_pct.toFixed(2)}%`);
  console.log(`  T-Bill 3M:         ${macroData.tbill_3m_pct.toFixed(2)}%  (${macroData.t3m_date})`);
  console.log(`  Treasury 10Y:      ${macroData.tbill_10y_pct.toFixed(2)}%  (${macroData.t10y_date})`);
  console.log(`  Fed Funds:         ${macroData.fed_funds_pct.toFixed(2)}%  (${macroData.ff_date})`);

  console.log('\n📡 On-chain encoding (as InflationOracle.cairo expects):');
  console.log(`  cpi_value      = ${encoded.cpi_1e2}       (felt252/u128)`);
  console.log(`  cpi_yoy_bps    = ${encoded.cpi_yoy_bps}         (felt252/u128)`);
  console.log(`  tbill_3m_bps   = ${encoded.tbill_3m_bps}         (felt252/u128)`);
  console.log(`  tbill_10y_bps  = ${encoded.tbill_10y_bps}         (felt252/u128)`);
  console.log(`  fed_funds_bps  = ${encoded.fed_funds_bps}         (felt252/u128)`);
  console.log(`  data_timestamp = ${encoded.data_timestamp}  (felt252/u64)`);

  if (CONFIG.PUBLISHER_PRIVATE_KEY) {
    const sig = signPayload(encoded, CONFIG.PUBLISHER_PRIVATE_KEY);
    console.log('\n🔐 Signature:');
    console.log(`  msg_hash    = ${sig.msgHash}`);
    console.log(`  signature_r = ${sig.r}`);
    console.log(`  signature_s = ${sig.s}`);
  } else {
    console.log('\n⚠️  PUBLISHER_PRIVATE_KEY not set — skipping signature');
  }

  const prevState = loadState();
  if (prevState) {
    console.log('\n📂 Last published state:');
    console.log(`  Round ID    : ${prevState.last_round_id}`);
    console.log(`  CPI (1e2)   : ${prevState.last_cpi_1e2}`);
    console.log(`  Published   : ${prevState.last_published_at}`);
    console.log(`  TX          : ${prevState.last_tx_hash}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  Check on-chain oracle state
// ─────────────────────────────────────────────────────────────
async function checkOnChain(): Promise<void> {
  if (!CONFIG.ORACLE_CONTRACT_ADDRESS) {
    console.error('ORACLE_CONTRACT_ADDRESS not set in .env'); process.exit(1);
  }
  const provider = new RpcProvider({ nodeUrl: CONFIG.STARKNET_RPC_URL });
  console.log('\n🔍 Reading InflationOracle state from Starknet...\n');
  const state = await readOnChainState(provider);
  console.log(`  Contract   : ${CONFIG.ORACLE_CONTRACT_ADDRESS}`);
  console.log(`  Round ID   : ${state.roundId}`);
  console.log(`  Data fresh : ${state.isFresh ? '✅ YES' : '⚠️  STALE'}`);
  console.log(`  Base CPI   : ${(state.baseCpi/100).toFixed(2)}`);
  console.log(`  Publishers : ${state.pubCount}`);
}

// ─────────────────────────────────────────────────────────────
//  Scheduler
// ─────────────────────────────────────────────────────────────
async function runScheduler(): Promise<void> {
  console.log('🚀 RWA Oracle Publisher — starting scheduler');
  console.log(`   Interval : every ${CONFIG.PUBLISH_INTERVAL_MS / 3600_000}h`);
  console.log(`   Contract : ${CONFIG.ORACLE_CONTRACT_ADDRESS}\n`);

  const run = async () => {
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        await publishCycle();
        break;
      } catch (err) {
        console.error(`\n[Oracle] ❌ Attempt ${attempt}/${CONFIG.MAX_RETRIES}: ${(err as Error).message}`);
        if (attempt < CONFIG.MAX_RETRIES) {
          console.log(`[Oracle] Retrying in ${CONFIG.RETRY_DELAY_MS/1000}s...`);
          await sleep(CONFIG.RETRY_DELAY_MS * attempt); // exponential backoff
        }
      }
    }
  };

  await run();
  setInterval(run, CONFIG.PUBLISH_INTERVAL_MS);
}

function validateConfig(): void {
  const required: string[] = ['PUBLISHER_ADDRESS', 'PUBLISHER_PRIVATE_KEY', 'ORACLE_CONTRACT_ADDRESS'];
  const missing = required.filter(k => !CONFIG[k as keyof typeof CONFIG]);
  if (missing.length) {
    console.error('❌ Missing required .env variables:', missing.join(', '));
    console.error('   Copy oracle-publisher/.env.example → .env and fill them in');
    process.exit(1);
  }
  if (!CONFIG.FRED_API_KEY) {
    console.warn('⚠️  FRED_API_KEY not set — FRED fetches will fail');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────
const cmd   = process.argv[2] || 'run';
const force = process.argv.includes('--force');

switch (cmd) {
  case 'dry-run':
    dryRun().catch(e => { console.error(e.message); process.exit(1); });
    break;
  case 'check':
    validateConfig();
    checkOnChain().catch(e => { console.error(e.message); process.exit(1); });
    break;
  case 'once':
    validateConfig();
    publishCycle(force).catch(e => { console.error(e.message); process.exit(1); });
    break;
  default:
    validateConfig();
    runScheduler().catch(e => { console.error(e.message); process.exit(1); });
}

export { fetchAllMacroData, encodeForOnChain, signPayload };

