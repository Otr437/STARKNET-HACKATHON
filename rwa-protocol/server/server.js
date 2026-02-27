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
SHA-256:  71CBB0D1AB320D7645A4C275CB411C350D71349C12BA00344C8C41C43D67216A
SHA-512:  6C004B3CF32B664305A74775156305CD0A2D948E48F9E6FFC8D04753D880264AFB3508488687198AA0B88F087383E2364F2CC77699EA8EA8741BBD6B931B13BD
MD5:      68D07AD4E4464AC90C105B2FC0AF44A7
File Size: 18923 bytes

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
 * RWA Protocol — Production Server
 *
 * Deployment: Render.com (render.yaml included), or any Node host
 *
 * Serves:
 *   GET  /                    → frontend/index.html
 *   GET  /api/all             → BLS CPI + all FRED rates (cached 30min)
 *   GET  /api/cpi             → BLS CPI-U CUUR0000SA0 only
 *   GET  /api/fred?series=X   → single FRED series
 *   GET  /api/starknet/call   → proxy Starknet RPC reads (avoids CORS on RPC nodes)
 *   POST /api/starknet/call   → proxy Starknet RPC writes
 *   GET  /health              → uptime + cache status (used by Render health checks)
 *
 * API keys read from .env — never sent to browser
 * Response cache prevents burning rate limits (BLS: 10/day without key)
 */

'use strict';
require('dotenv').config();

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Environment ────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT || '3000', 10);
const BLS_KEY  = process.env.BLS_API_KEY  || '';
const FRED_KEY = process.env.FRED_API_KEY || '';
const RPC_URL  = process.env.STARKNET_RPC_URL || 'https://starknet-mainnet.public.blastapi.io/rpc/v0_7';
const FRONTEND = path.join(__dirname, '../frontend/index.html');

// ── In-memory response cache ───────────────────────────────
// Keyed by endpoint string, value: { data, expires_at }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — BLS data is monthly, FRED daily
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expires_at: Date.now() + CACHE_TTL_MS });
}

// ── Request log (ring buffer, last 500 entries) ────────────
const LOG_LIMIT = 500;
const reqLog = [];
function logReq(method, path, status, ms, note) {
  const entry = { ts: new Date().toISOString(), method, path, status, ms, note: note || '' };
  reqLog.push(entry);
  if (reqLog.length > LOG_LIMIT) reqLog.shift();
  const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
  console.log(color + entry.ts.slice(11,19) + ' ' + method + ' ' + path + ' ' + status + ' ' + ms + 'ms' + (note ? ' — ' + note : '') + '\x1b[0m');
}

const startTime = Date.now();

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(hostname, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname,
      port: 443,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent':     'RWA-Protocol-Server/1.0',
        ...extraHeaders,
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' from ' + hostname + urlPath + ': ' + buf.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('JSON parse error from ' + hostname + ': ' + e.message)); }
      });
    });
    req.on('error', e => reject(new Error('Network error to ' + hostname + ': ' + e.message)));
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: { 'User-Agent': 'RWA-Protocol-Server/1.0' },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' from ' + hostname + urlPath));
          return;
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.end();
  });
}

// ── BLS CPI Parser ─────────────────────────────────────────
// Real BLS API v2: POST https://api.bls.gov/publicAPI/v2/timeseries/data/
// Series CUUR0000SA0 = CPI-U All Urban Consumers, All Items, Not Seasonally Adjusted
//
// Response field meanings:
//   year     = "2025"
//   period   = "M12"  (M01–M12 = Jan–Dec, M13 = annual avg — we filter this out)
//   value    = "314.856"  (the raw CPI index value, not a % change)
//   footnotes[].code = "P" means preliminary — exclude from calculations
//
// On-chain encoding for InflationOracle.cairo:
//   cpi_1e2   = Math.round(value * 100)  e.g. 314.856 → 31486
//   yoy_bps   = Math.round(yoy_pct * 100) e.g. 2.7% → 270
async function fetchBLS() {
  const cacheKey = 'bls_cpi';
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, from_cache: true };

  const year = new Date().getFullYear();
  const body = {
    seriesid:     ['CUUR0000SA0'],
    startyear:    String(year - 2),
    endyear:      String(year),
    annualaverage: false,
  };
  if (BLS_KEY) body.registrationkey = BLS_KEY;

  const json = await httpsPost('api.bls.gov', '/publicAPI/v2/timeseries/data/', body);

  if (json.status !== 'REQUEST_SUCCEEDED') {
    const msgs = Array.isArray(json.message) ? json.message.join('; ') : String(json.message || 'unknown');
    throw new Error('BLS API error: ' + msgs);
  }

  const rawData = json.Results?.series?.[0]?.data;
  if (!rawData || rawData.length === 0) {
    throw new Error('BLS: no series data returned for CUUR0000SA0');
  }

  // Filter out:
  //   - Annual averages (period M13)
  //   - Preliminary data points (footnote code P)
  const finalData = rawData.filter(d =>
    d.period !== 'M13' &&
    !d.footnotes?.some(f => f.code === 'P')
  );

  if (finalData.length < 13) {
    throw new Error('BLS: only ' + finalData.length + ' final data points available (need 13 for YoY). ' +
      'This may happen early in a year before previous year is finalized.');
  }

  // BLS returns data newest-first
  const latest   = finalData[0];
  const prevYear = finalData[12]; // exactly 12 months prior

  const cpi      = parseFloat(latest.value);
  const cpiPrev  = parseFloat(prevYear.value);

  if (isNaN(cpi) || isNaN(cpiPrev)) {
    throw new Error('BLS: could not parse CPI values: latest="' + latest.value + '" prev="' + prevYear.value + '"');
  }

  const yoyPct   = ((cpi - cpiPrev) / cpiPrev) * 100;

  // Build 12-month sparkline history oldest→newest
  const history  = finalData.slice(0, 12).reverse().map(d => {
    const v = parseFloat(d.value);
    if (isNaN(v)) throw new Error('BLS: non-numeric value in history: ' + d.value);
    return v;
  });

  // Decode BLS period to ISO date string
  // M01 = January, M12 = December
  const monthNum = latest.period.replace('M', '').padStart(2, '0');
  const date     = latest.year + '-' + monthNum + '-01';
  const period   = latest.periodName + ' ' + latest.year;

  // Starknet on-chain encoding
  const cpi_1e2  = Math.round(cpi * 100);     // e.g. 31486
  const yoy_bps  = Math.round(yoyPct * 100);  // e.g. 270 = 2.70%

  const result = { cpi, yoyPct, history, date, period, cpi_1e2, yoy_bps };
  cacheSet(cacheKey, result);
  return result;
}

// ── FRED Series Parser ─────────────────────────────────────
// GET https://api.stlouisfed.org/fred/series/observations
//
// Series used:
//   TB3MS   = 3-Month Treasury Bill Secondary Market Rate (weekly, %)
//   DGS10   = Market Yield on U.S. Treasury Securities at 10-Year (daily, %)
//   FEDFUNDS = Federal Funds Effective Rate (monthly, %)
//
// Response:
//   observations[].value = "5.25" (percent, NOT basis points)
//   observations[].value = "." means missing data — skip
//
// On-chain encoding:
//   bps = Math.round(value * 100)  e.g. 5.25% → 525 basis points
async function fetchFRED(series) {
  if (!FRED_KEY) {
    throw new Error('FRED_API_KEY not set in .env — required for series ' + series +
      '. Register free at https://fred.stlouisfed.org/docs/api/api_key.html');
  }

  const cacheKey = 'fred_' + series;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, from_cache: true };

  const fredPath = '/fred/series/observations' +
    '?series_id=' + encodeURIComponent(series) +
    '&api_key='   + encodeURIComponent(FRED_KEY) +
    '&file_type=json' +
    '&limit=10' +
    '&sort_order=desc';

  const json = await httpsGet('api.stlouisfed.org', fredPath);

  if (json.error_code || json.error_message) {
    throw new Error('FRED [' + series + ']: ' + (json.error_message || 'error code ' + json.error_code));
  }

  if (!json.observations || json.observations.length === 0) {
    throw new Error('FRED [' + series + ']: no observations returned');
  }

  // Find most recent non-missing value
  const valid = json.observations.filter(o => o.value !== '.' && o.value !== '' && !isNaN(parseFloat(o.value)));
  if (valid.length === 0) {
    throw new Error('FRED [' + series + ']: all recent observations are missing (.)');
  }

  const latest = valid[0];
  const value  = parseFloat(latest.value);

  if (isNaN(value)) {
    throw new Error('FRED [' + series + ']: non-numeric value "' + latest.value + '"');
  }

  // Basis points for Starknet on-chain storage
  const bps = Math.round(value * 100);

  const result = { series, value, date: latest.date, bps };
  cacheSet(cacheKey, result);
  return result;
}

// ── /api/all — fetch everything in parallel ────────────────
async function handleAll(res) {
  const cacheKey = 'all';
  const cached = cacheGet(cacheKey);
  if (cached) {
    sendJSON(res, { ...cached, from_cache: true });
    return;
  }

  // Parallel requests — BLS + 3 FRED series
  const [bls, t3m, t10y, ff] = await Promise.all([
    fetchBLS(),
    fetchFRED('TB3MS'),
    fetchFRED('DGS10'),
    fetchFRED('FEDFUNDS'),
  ]);

  const result = {
    // Human-readable (for display)
    cpi:           bls.cpi,
    yoy_pct:       bls.yoyPct,
    tbill_3m_pct:  t3m.value,
    tbill_10y_pct: t10y.value,
    fed_funds_pct: ff.value,

    // Source provenance
    cpi_date:   bls.date,
    cpi_period: bls.period,
    t3m_date:   t3m.date,
    t10y_date:  t10y.date,
    ff_date:    ff.date,
    history:    bls.history,

    // On-chain encoded values — exactly what InflationOracle.cairo stores
    // These are the values the oracle publisher signs and submits on-chain
    onchain: {
      cpi_1e2:       bls.cpi_1e2,       // CPI * 100, integer  e.g. 31486
      cpi_yoy_bps:   bls.yoy_bps,       // YoY % * 100, bps    e.g. 270
      tbill_3m_bps:  t3m.bps,           // rate % * 100, bps   e.g. 529
      tbill_10y_bps: t10y.bps,          // rate % * 100, bps   e.g. 456
      fed_funds_bps: ff.bps,            // rate % * 100, bps   e.g. 533
    },

    fetched_at: new Date().toISOString(),
    from_cache: false,
  };

  cacheSet(cacheKey, result);
  sendJSON(res, result);
}

// ── /api/starknet/call — proxy Starknet RPC ───────────────
// Proxies both reads (GET with query) and writes (POST with body)
// Avoids CORS issues with RPC nodes that don't allow browser requests
async function handleStarknetCall(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        let payload;
        try { payload = JSON.parse(body); }
        catch(e) { sendError(res, 400, 'Invalid JSON body'); resolve(); return; }

        const rpcParsed = new URL(RPC_URL);
        const result = await httpsPost(rpcParsed.hostname, rpcParsed.pathname + rpcParsed.search, payload);
        sendJSON(res, result);
        resolve();
      } catch(e) {
        sendError(res, 502, 'Starknet RPC error: ' + e.message);
        resolve();
      }
    });
    req.on('error', reject);
  });
}

// ── Static file server ─────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendError(res, 404, 'File not found: ' + filePath); return; }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ── Response helpers ───────────────────────────────────────
function sendJSON(res, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache',
    'X-RWA-Version':               '1.0.0',
  });
  res.end(body);
}

function sendError(res, code, msg) {
  const body = JSON.stringify({ error: msg, code, ts: new Date().toISOString() });
  res.writeHead(code, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── Main request handler ───────────────────────────────────
const server = http.createServer(async (req, res) => {
  const t0       = Date.now();
  const parsed   = url.parse(req.url || '/', true);
  const pathname = parsed.pathname || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    });
    res.end();
    return;
  }

  let status = 200;
  let note   = '';

  try {
    // ── Health check (Render uses this to verify service is up) ──
    if (pathname === '/health' || pathname === '/healthz') {
      const cacheKeys = Array.from(cache.keys());
      const uptime    = Math.floor((Date.now() - startTime) / 1000);
      sendJSON(res, {
        status:     'ok',
        uptime_sec: uptime,
        cache: {
          entries: cacheKeys.length,
          keys:    cacheKeys,
        },
        config: {
          bls_key_set:  !!BLS_KEY,
          fred_key_set: !!FRED_KEY,
          rpc_url:      RPC_URL.replace(/api_key=[^&]+/, 'api_key=REDACTED'),
        },
        recent_requests: reqLog.slice(-10),
      });
      logReq(req.method, pathname, 200, Date.now() - t0, 'health');
      return;
    }

    // ── API: all macro data ──
    if (pathname === '/api/all' && req.method === 'GET') {
      note = cacheGet('all') ? 'cache hit' : 'live fetch';
      await handleAll(res);

    // ── API: BLS CPI only ──
    } else if (pathname === '/api/cpi' && req.method === 'GET') {
      note = cacheGet('bls_cpi') ? 'cache hit' : 'live fetch';
      const bls = await fetchBLS();
      sendJSON(res, bls);

    // ── API: single FRED series ──
    } else if (pathname === '/api/fred' && req.method === 'GET') {
      const series = parsed.query.series;
      if (!series) { sendError(res, 400, 'Missing ?series= parameter. Use TB3MS, DGS10, or FEDFUNDS'); status = 400; }
      else {
        note = cacheGet('fred_' + series) ? 'cache hit' : 'live fetch';
        const data = await fetchFRED(series);
        sendJSON(res, data);
      }

    // ── API: cache status ──
    } else if (pathname === '/api/cache' && req.method === 'DELETE') {
      cache.clear();
      sendJSON(res, { cleared: true, ts: new Date().toISOString() });
      note = 'cache cleared';

    // ── API: Starknet RPC proxy ──
    } else if (pathname === '/api/starknet/call' && req.method === 'POST') {
      await handleStarknetCall(req, res);
      note = 'rpc proxy';

    // ── Static: frontend index ──
    } else if (pathname === '/' || pathname === '/index.html') {
      serveFile(res, FRONTEND);
      note = 'static';

    // ── 404 ──
    } else {
      status = 404;
      sendError(res, 404, 'Not found: ' + pathname);
    }

  } catch (err) {
    status = 500;
    note   = err.message;
    console.error('\x1b[31m[ERROR]\x1b[0m', err.message);
    sendError(res, 500, err.message);
  }

  logReq(req.method, pathname, status, Date.now() - t0, note);
});

// ── Start ──────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log('  🏦 RWA Protocol Server  v1.0.0');
  console.log(line);
  console.log('  URL       : http://localhost:' + PORT);
  console.log('  Dashboard : http://localhost:' + PORT + '/');
  console.log('  Health    : http://localhost:' + PORT + '/health');
  console.log('  BLS key   : ' + (BLS_KEY  ? '✓ configured (500 req/day)' : '✗ not set (10 req/day — BLS still works, just limited)'));
  console.log('  FRED key  : ' + (FRED_KEY ? '✓ configured' : '✗ NOT SET — rate data will return 500 errors'));
  console.log('  RPC URL   : ' + RPC_URL.slice(0, 60));
  console.log('  Cache TTL : 30 minutes');
  console.log(line + '\n');

  if (!FRED_KEY) {
    console.log('\x1b[33m  ⚠  FRED_API_KEY missing!\x1b[0m');
    console.log('     Rate data endpoints will fail until you set it in .env');
    console.log('     Free key: https://fred.stlouisfed.org/docs/api/api_key.html\n');
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('\x1b[31m[FATAL] Port ' + PORT + ' already in use. Kill the other process or set PORT= in .env\x1b[0m');
  } else {
    console.error('\x1b[31m[FATAL] Server error:\x1b[0m', err.message);
  }
  process.exit(1);
});

