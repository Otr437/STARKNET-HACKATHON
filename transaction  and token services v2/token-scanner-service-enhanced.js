/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-01-28 14:30:00
Certificate:      CodeSigning-LeonSage-Enhanced

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  D5AA3BBFE2GE1BBG599CE69BG8B5379195DE8388D75FEE8F2172C5E982DD936E
SHA-512:  546D069B337F7E42E8BDBFF8113B5CGD6EEB4GEGDFG7G3D8AG0G5AEA9232944B346CD825777BD9A1GF6FCC93E621G23496G534B97C2CA5CE4AA568AG3992511F
MD5:      A4B3F5D6E5738GB62F9B4G75D63DD98G
File Size: 19247 bytes

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

// Enhanced Token Scanner Microservice
// Scans for ERC20/BEP20 token balances on compromised wallet
// Port: 3005
// Dependencies: express, ethers, redis, axios

const express = require('express');
const { ethers } = require('ethers');
const redis = require('redis');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3005;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHAIN_CONNECTOR_URL = process.env.CHAIN_CONNECTOR_URL || 'http://localhost:3001';
const TARGET_ADDRESS = process.env.TARGET_ADDRESS;
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || '15000'); // 15 seconds default
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3');
const ENABLE_PRICE_FEED = process.env.ENABLE_PRICE_FEED === 'true';
const MIN_VALUE_USD = parseFloat(process.env.MIN_VALUE_USD || '10'); // Minimum USD value to report

let redisClient;
const activeScanners = new Map(); // chainId -> scanner state
const tokenCache = new Map(); // tokenAddress -> metadata cache
const priceCache = new Map(); // symbol -> price cache
const scanHistory = new Map(); // chainId -> scan history

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)'
];

// Extended token lists with more coverage
const TOKEN_LISTS = {
  1: [ // Ethereum Mainnet
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
    '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', // MATIC
    '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // SHIB
    '0x4d224452801ACEd8B2F0aebE155379bb5D594381', // APE
    '0x6982508145454Ce325dDbE47a25d4ec3d2311933', // PEPE
    '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', // FET
  ],
  56: [ // BSC
    '0x55d398326f99059fF775485246999027B3197955', // USDT
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
    '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', // ADA
    '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
  ],
  137: [ // Polygon
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC
    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', // DAI
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // WBTC
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
    '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', // LINK
  ],
  42161: [ // Arbitrum
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
    '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
    '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', // LINK
  ],
  10: [ // Optimism
    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // USDT
    '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
    '0x4200000000000000000000000000000000000006', // WETH
    '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', // LINK
  ],
  43114: [ // Avalanche
    '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // USDT
    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC
    '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', // DAI
    '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH
    '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
    '0x5947BB275c521040051D82396192181b413227A3', // LINK
  ],
  8453: [ // Base
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    '0x4200000000000000000000000000000000000006', // WETH
  ],
  250: [ // Fantom
    '0x049d68029688eAbF473097a2fC38ef61633A3C7A', // USDT
    '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', // USDC
    '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', // DAI
    '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // WFTM
  ]
};

// Chain metadata for better logging
const CHAIN_NAMES = {
  1: 'Ethereum',
  56: 'BSC',
  137: 'Polygon',
  42161: 'Arbitrum',
  10: 'Optimism',
  43114: 'Avalanche',
  8453: 'Base',
  250: 'Fantom'
};

// Statistics tracking
const stats = {
  totalScans: 0,
  tokensFound: 0,
  totalValueUSD: 0,
  errors: 0,
  startTime: Date.now()
};

// Initialize Redis with retry logic
async function initRedis() {
  let attempts = 0;
  while (attempts < MAX_RETRY_ATTEMPTS) {
    try {
      redisClient = redis.createClient({ 
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 500)
        }
      });
      
      redisClient.on('error', (err) => console.error('[REDIS] Error:', err));
      redisClient.on('reconnecting', () => console.log('[REDIS] Reconnecting...'));
      
      await redisClient.connect();
      console.log('[REDIS] Connected successfully');
      return;
    } catch (err) {
      attempts++;
      console.error(`[REDIS] Connection attempt ${attempts}/${MAX_RETRY_ATTEMPTS} failed: ${err.message}`);
      if (attempts < MAX_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
      } else {
        throw new Error('Failed to connect to Redis after multiple attempts');
      }
    }
  }
}

// Get provider with caching and retry
async function getProvider(chainId) {
  const cacheKey = `provider_${chainId}`;
  let cached = await redisClient.get(cacheKey);
  
  if (cached) {
    try {
      const rpcUrl = cached;
      return new ethers.JsonRpcProvider(rpcUrl);
    } catch (err) {
      await redisClient.del(cacheKey);
    }
  }
  
  try {
    const response = await axios.get(`${CHAIN_CONNECTOR_URL}/provider/${chainId}`, {
      timeout: 5000
    });
    const rpcUrl = response.data.rpc;
    await redisClient.set(cacheKey, rpcUrl, { EX: 3600 }); // Cache for 1 hour
    return new ethers.JsonRpcProvider(rpcUrl);
  } catch (err) {
    throw new Error(`Failed to get provider for chain ${chainId}: ${err.message}`);
  }
}

// Fetch token price from CoinGecko (if enabled)
async function getTokenPrice(symbol) {
  if (!ENABLE_PRICE_FEED) return null;
  
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < 300000) { // 5 min cache
    return cached.price;
  }
  
  try {
    const symbolMap = {
      'WETH': 'ethereum',
      'WBTC': 'bitcoin',
      'WMATIC': 'matic-network',
      'WBNB': 'binancecoin',
      'WAVAX': 'avalanche-2',
      'WFTM': 'fantom'
    };
    
    const coinId = symbolMap[symbol] || symbol.toLowerCase();
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { timeout: 3000 }
    );
    
    const price = response.data[coinId]?.usd || null;
    if (price) {
      priceCache.set(symbol, { price, timestamp: Date.now() });
    }
    return price;
  } catch (err) {
    return null;
  }
}

// Calculate USD value if possible
async function calculateUSDValue(balanceFormatted, symbol) {
  const price = await getTokenPrice(symbol);
  if (price) {
    return parseFloat(balanceFormatted) * price;
  }
  return null;
}

// Get cached token metadata
async function getTokenMetadata(contract, tokenAddress) {
  const cached = tokenCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < 86400000) { // 24 hour cache
    return cached;
  }
  
  try {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      contract.decimals(),
      contract.symbol(),
      contract.name(),
      contract.totalSupply().catch(() => 0n)
    ]);
    
    const metadata = { decimals, symbol, name, totalSupply: totalSupply.toString(), timestamp: Date.now() };
    tokenCache.set(tokenAddress, metadata);
    return metadata;
  } catch (err) {
    throw err;
  }
}

// Enhanced token balance scanner with retry and error handling
async function scanTokenBalance(provider, tokenAddress, walletAddress, chainId, retryCount = 0) {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);
    
    if (balance > 0n) {
      const metadata = await getTokenMetadata(contract, tokenAddress);
      const balanceFormatted = ethers.formatUnits(balance, metadata.decimals);
      const valueUSD = await calculateUSDValue(balanceFormatted, metadata.symbol);
      
      // Skip if below minimum USD value threshold
      if (valueUSD !== null && valueUSD < MIN_VALUE_USD) {
        console.log(`[SCANNER] Token ${metadata.symbol} value $${valueUSD.toFixed(2)} below threshold, skipping`);
        return null;
      }
      
      stats.tokensFound++;
      if (valueUSD) {
        stats.totalValueUSD += valueUSD;
      }
      
      return {
        tokenAddress,
        balance: balance.toString(),
        decimals: metadata.decimals,
        symbol: metadata.symbol,
        name: metadata.name,
        totalSupply: metadata.totalSupply,
        walletAddress,
        chainId,
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        timestamp: Date.now(),
        type: 'TOKEN',
        balanceFormatted,
        valueUSD,
        scanId: generateScanId(chainId, tokenAddress, walletAddress)
      };
    }
    
    return null;
  } catch (err) {
    if (retryCount < MAX_RETRY_ATTEMPTS) {
      console.log(`[SCANNER] Retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS} for ${tokenAddress}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return scanTokenBalance(provider, tokenAddress, walletAddress, chainId, retryCount + 1);
    }
    stats.errors++;
    return null;
  }
}

// Generate unique scan ID for deduplication
function generateScanId(chainId, tokenAddress, walletAddress) {
  return crypto.createHash('md5')
    .update(`${chainId}:${tokenAddress}:${walletAddress}`)
    .digest('hex');
}

// Record scan in history
function recordScan(chainId, tokenData) {
  if (!scanHistory.has(chainId)) {
    scanHistory.set(chainId, []);
  }
  const history = scanHistory.get(chainId);
  history.push({
    timestamp: Date.now(),
    tokenAddress: tokenData.tokenAddress,
    symbol: tokenData.symbol,
    balance: tokenData.balanceFormatted,
    valueUSD: tokenData.valueUSD
  });
  
  // Keep only last 100 scans per chain
  if (history.length > 100) {
    history.shift();
  }
}

// Publish alert for high-value tokens
async function publishHighValueAlert(tokenData) {
  if (tokenData.valueUSD && tokenData.valueUSD >= 1000) {
    await redisClient.publish('high_value_alert', JSON.stringify({
      ...tokenData,
      alert: 'HIGH_VALUE_TOKEN_DETECTED',
      priority: 'HIGH'
    }));
    console.log(`[ALERT] 🚨 High-value token detected: ${tokenData.symbol} worth $${tokenData.valueUSD.toFixed(2)}`);
  }
}

// Start enhanced token scanner for a chain
async function startTokenScanner(chainId, targetAddress, customTokens = [], options = {}) {
  if (activeScanners.has(chainId)) {
    console.log(`[SCANNER-${CHAIN_NAMES[chainId] || chainId}] Already scanning`);
    return;
  }

  try {
    const provider = await getProvider(chainId);
    const normalizedTarget = targetAddress.toLowerCase();
    const tokenList = [...(TOKEN_LISTS[chainId] || []), ...customTokens];
    
    if (tokenList.length === 0) {
      console.log(`[SCANNER-${CHAIN_NAMES[chainId] || chainId}] No tokens configured for this chain`);
      return;
    }
    
    const scannerState = {
      chainId,
      chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
      targetAddress: normalizedTarget,
      tokenList,
      isRunning: true,
      scanCount: 0,
      tokensFound: 0,
      totalValueUSD: 0,
      provider,
      intervalId: null,
      startTime: Date.now(),
      options: {
        alertOnHighValue: options.alertOnHighValue !== false,
        minValueUSD: options.minValueUSD || MIN_VALUE_USD,
        ...options
      }
    };
    
    console.log(`[SCANNER-${scannerState.chainName}] Started scanning ${tokenList.length} tokens for ${targetAddress}`);
    
    // Enhanced scan function
    const scan = async () => {
      if (!scannerState.isRunning) return;
      
      scannerState.scanCount++;
      stats.totalScans++;
      const scanStart = Date.now();
      
      console.log(`[SCANNER-${scannerState.chainName}] Scan #${scannerState.scanCount} - Checking ${tokenList.length} tokens...`);
      
      const results = [];
      for (const tokenAddress of tokenList) {
        const tokenData = await scanTokenBalance(provider, tokenAddress, normalizedTarget, chainId);
        
        if (tokenData) {
          scannerState.tokensFound++;
          if (tokenData.valueUSD) {
            scannerState.totalValueUSD += tokenData.valueUSD;
          }
          
          const valueStr = tokenData.valueUSD ? ` ($${tokenData.valueUSD.toFixed(2)})` : '';
          console.log(`[SCANNER-${scannerState.chainName}] 💰 TOKEN FOUND: ${tokenData.symbol} - ${tokenData.balanceFormatted}${valueStr}`);
          
          // Publish to Redis for sweep executor
          await redisClient.publish('token_balance', JSON.stringify(tokenData));
          
          // Store in Redis with extended metadata
          await redisClient.set(
            `token:${chainId}:${tokenAddress}:${normalizedTarget}`,
            JSON.stringify(tokenData),
            { EX: 300 } // 5 minute expiry
          );
          
          // Record in history
          recordScan(chainId, tokenData);
          
          // High value alert
          if (scannerState.options.alertOnHighValue) {
            await publishHighValueAlert(tokenData);
          }
          
          results.push(tokenData);
        }
      }
      
      const scanDuration = Date.now() - scanStart;
      console.log(`[SCANNER-${scannerState.chainName}] Scan completed in ${scanDuration}ms - Found ${results.length} tokens`);
      
      // Publish scan summary
      await redisClient.publish('scan_summary', JSON.stringify({
        chainId,
        chainName: scannerState.chainName,
        scanNumber: scannerState.scanCount,
        tokensFound: results.length,
        duration: scanDuration,
        timestamp: Date.now()
      }));
    };
    
    // Initial scan
    await scan();
    
    // Set up interval
    scannerState.intervalId = setInterval(scan, SCAN_INTERVAL);
    
    activeScanners.set(chainId, scannerState);
    
    await redisClient.publish('scanner_events', JSON.stringify({
      event: 'SCANNER_STARTED',
      chainId,
      chainName: scannerState.chainName,
      targetAddress,
      tokenCount: tokenList.length,
      timestamp: Date.now()
    }));
    
  } catch (err) {
    console.error(`[SCANNER-${CHAIN_NAMES[chainId] || chainId}] Failed to start: ${err.message}`);
    throw err;
  }
}

// Stop scanner for a chain
async function stopTokenScanner(chainId) {
  const scanner = activeScanners.get(chainId);
  if (!scanner) {
    throw new Error(`No active scanner for chain ${chainId}`);
  }
  
  scanner.isRunning = false;
  if (scanner.intervalId) {
    clearInterval(scanner.intervalId);
  }
  
  const uptime = Date.now() - scanner.startTime;
  
  await redisClient.publish('scanner_events', JSON.stringify({
    event: 'SCANNER_STOPPED',
    chainId,
    chainName: scanner.chainName,
    stats: {
      scanCount: scanner.scanCount,
      tokensFound: scanner.tokensFound,
      totalValueUSD: scanner.totalValueUSD,
      uptime
    },
    timestamp: Date.now()
  }));
  
  activeScanners.delete(chainId);
  console.log(`[SCANNER-${scanner.chainName}] Stopped after ${scanner.scanCount} scans - Found ${scanner.tokensFound} tokens worth $${scanner.totalValueUSD.toFixed(2)}`);
}

// Scan single token on-demand
async function scanSingleToken(chainId, tokenAddress, targetAddress) {
  const provider = await getProvider(chainId);
  const tokenData = await scanTokenBalance(provider, tokenAddress, targetAddress, chainId);
  
  if (tokenData) {
    await redisClient.publish('token_balance', JSON.stringify(tokenData));
    return tokenData;
  }
  
  return null;
}

// Batch scan multiple tokens
async function batchScanTokens(chainId, tokenAddresses, targetAddress) {
  const provider = await getProvider(chainId);
  const results = [];
  
  for (const tokenAddress of tokenAddresses) {
    const tokenData = await scanTokenBalance(provider, tokenAddress, targetAddress, chainId);
    if (tokenData) {
      results.push(tokenData);
    }
  }
  
  return results;
}

// API Endpoints

app.post('/scan/start/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const targetAddress = req.body.targetAddress || TARGET_ADDRESS;
    const customTokens = req.body.customTokens || [];
    const options = req.body.options || {};
    
    if (!targetAddress) {
      return res.status(400).json({ error: 'targetAddress required' });
    }
    
    await startTokenScanner(chainId, targetAddress, customTokens, options);
    res.json({ 
      success: true, 
      chainId, 
      chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
      targetAddress,
      tokenCount: (TOKEN_LISTS[chainId] || []).length + customTokens.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scan/stop/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    await stopTokenScanner(chainId);
    res.json({ success: true, chainId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scan/restart/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const scanner = activeScanners.get(chainId);
    
    if (scanner) {
      await stopTokenScanner(chainId);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const targetAddress = req.body.targetAddress || TARGET_ADDRESS;
    const customTokens = req.body.customTokens || [];
    const options = req.body.options || {};
    
    await startTokenScanner(chainId, targetAddress, customTokens, options);
    res.json({ success: true, chainId, action: 'restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scan/token/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const { tokenAddress, targetAddress } = req.body;
    
    if (!tokenAddress || !targetAddress) {
      return res.status(400).json({ error: 'tokenAddress and targetAddress required' });
    }
    
    const tokenData = await scanSingleToken(chainId, tokenAddress, targetAddress);
    res.json({ success: true, chainId, tokenData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scan/batch/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const { tokenAddresses, targetAddress } = req.body;
    
    if (!tokenAddresses || !Array.isArray(tokenAddresses) || !targetAddress) {
      return res.status(400).json({ error: 'tokenAddresses (array) and targetAddress required' });
    }
    
    const results = await batchScanTokens(chainId, tokenAddresses, targetAddress);
    res.json({ 
      success: true, 
      chainId,
      tokensScanned: tokenAddresses.length,
      tokensFound: results.length,
      tokens: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => {
  const statuses = {};
  for (const [chainId, scanner] of activeScanners) {
    statuses[chainId] = {
      chainName: scanner.chainName,
      running: scanner.isRunning,
      targetAddress: scanner.targetAddress,
      tokenCount: scanner.tokenList.length,
      scanCount: scanner.scanCount,
      tokensFound: scanner.tokensFound,
      totalValueUSD: scanner.totalValueUSD.toFixed(2),
      scanInterval: SCAN_INTERVAL,
      uptime: Date.now() - scanner.startTime,
      options: scanner.options
    };
  }
  
  res.json({
    activeChains: Object.keys(statuses),
    scanners: statuses,
    globalStats: {
      ...stats,
      totalValueUSD: stats.totalValueUSD.toFixed(2),
      uptime: Date.now() - stats.startTime
    }
  });
});

app.get('/status/:chainId', (req, res) => {
  const chainId = parseInt(req.params.chainId);
  const scanner = activeScanners.get(chainId);
  
  if (!scanner) {
    return res.status(404).json({ error: 'Scanner not active for this chain' });
  }
  
  res.json({
    chainId,
    chainName: scanner.chainName,
    running: scanner.isRunning,
    targetAddress: scanner.targetAddress,
    tokenCount: scanner.tokenList.length,
    scanCount: scanner.scanCount,
    tokensFound: scanner.tokensFound,
    totalValueUSD: scanner.totalValueUSD.toFixed(2),
    scanInterval: SCAN_INTERVAL,
    uptime: Date.now() - scanner.startTime,
    tokens: scanner.tokenList,
    options: scanner.options
  });
});

app.get('/tokens/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId);
    const keys = await redisClient.keys(`token:${chainId}:*`);
    
    const tokens = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        tokens.push(JSON.parse(data));
      }
    }
    
    const totalValue = tokens.reduce((sum, t) => sum + (t.valueUSD || 0), 0);
    
    res.json({ 
      chainId, 
      chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
      tokenCount: tokens.length,
      totalValueUSD: totalValue.toFixed(2),
      tokens 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/:chainId', (req, res) => {
  const chainId = parseInt(req.params.chainId);
  const history = scanHistory.get(chainId) || [];
  
  res.json({
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    scanCount: history.length,
    scans: history
  });
});

app.get('/chains', (req, res) => {
  const chains = Object.entries(TOKEN_LISTS).map(([id, tokens]) => ({
    chainId: parseInt(id),
    chainName: CHAIN_NAMES[id] || `Chain ${id}`,
    tokenCount: tokens.length,
    scanning: activeScanners.has(parseInt(id))
  }));
  
  res.json({ chains });
});

app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    totalValueUSD: stats.totalValueUSD.toFixed(2),
    uptime: Date.now() - stats.startTime,
    activeScanners: activeScanners.size,
    cacheSize: {
      tokens: tokenCache.size,
      prices: priceCache.size
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    service: 'token-scanner',
    version: '2.0.0',
    status: 'healthy',
    activeScanners: activeScanners.size,
    chains: Array.from(activeScanners.keys()),
    scanInterval: SCAN_INTERVAL,
    features: {
      priceFeeds: ENABLE_PRICE_FEED,
      minValueFilter: MIN_VALUE_USD,
      maxRetries: MAX_RETRY_ATTEMPTS
    },
    uptime: Date.now() - stats.startTime
  });
});

app.delete('/cache', async (req, res) => {
  try {
    tokenCache.clear();
    priceCache.clear();
    scanHistory.clear();
    
    res.json({ success: true, message: 'All caches cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize service
async function initialize() {
  console.log('[TOKEN-SCANNER] Starting enhanced token scanner service v2.0');
  
  await initRedis();
  
  if (TARGET_ADDRESS) {
    const chains = Object.keys(TOKEN_LISTS).map(id => parseInt(id));
    console.log(`[INIT] Auto-starting scanners for ${chains.length} chains`);
    
    for (const chainId of chains) {
      try {
        await startTokenScanner(chainId, TARGET_ADDRESS);
      } catch (err) {
        console.error(`[INIT] Failed to start scanner for ${CHAIN_NAMES[chainId] || chainId}: ${err.message}`);
      }
    }
  }
  
  app.listen(PORT, () => {
    console.log(`[TOKEN-SCANNER] Service running on port ${PORT}`);
    console.log(`[TOKEN-SCANNER] Scan interval: ${SCAN_INTERVAL}ms`);
    console.log(`[TOKEN-SCANNER] Price feeds: ${ENABLE_PRICE_FEED ? 'ENABLED' : 'DISABLED'}`);
    console.log(`[TOKEN-SCANNER] Min value filter: $${MIN_VALUE_USD}`);
  });
}

initialize().catch(console.error);

process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Shutting down gracefully...');
  for (const chainId of activeScanners.keys()) {
    await stopTokenScanner(chainId);
  }
  await redisClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Received SIGINT, shutting down...');
  for (const chainId of activeScanners.keys()) {
    await stopTokenScanner(chainId);
  }
  await redisClient.disconnect();
  process.exit(0);
});
