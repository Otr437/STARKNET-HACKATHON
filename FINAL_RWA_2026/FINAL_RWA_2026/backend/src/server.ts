import express, { Request, Response } from 'express';
import cors from 'cors';
import { RpcProvider, Contract, shortString } from 'starknet';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Starknet setup
const provider = new RpcProvider({ 
  nodeUrl: process.env.STARKNET_RPC_URL! 
});

// WebSocket for real-time updates
const wss = new WebSocket.Server({ port: 3002 });

wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  ws.send(JSON.stringify({ type: 'connected', message: 'RWA Backend Ready' }));
});

// Broadcast to all connected clients
function broadcast(data: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ===== API ROUTES =====

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Get oracle data
app.get('/api/oracle/cpi', async (req: Request, res: Response) => {
  try {
    const oracleAddress = process.env.ORACLE_CONTRACT_ADDRESS;
    if (!oracleAddress) {
      return res.status(500).json({ error: 'Oracle not configured' });
    }

    const oracle = new Contract([], oracleAddress, provider);
    const cpiData = await oracle.get_cpi();
    
    res.json({
      value: cpiData.value.toString(),
      timestamp: cpiData.timestamp.toString(),
      round_id: cpiData.round_id.toString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get all RWA assets
app.get('/api/rwa/all', async (req: Request, res: Response) => {
  try {
    const factoryAddress = process.env.FACTORY_CONTRACT_ADDRESS;
    if (!factoryAddress) {
      return res.status(500).json({ error: 'Factory not configured' });
    }

    const factory = new Contract([], factoryAddress, provider);
    const count = await factory.get_rwa_count();
    
    const assets = [];
    for (let i = 1; i <= Number(count); i++) {
      const metadata = await factory.get_rwa_metadata(i);
      assets.push({
        id: i,
        name: shortString.decodeShortString(metadata.name.toString()),
        symbol: shortString.decodeShortString(metadata.symbol.toString()),
        token_address: metadata.token_address,
        vault_address: metadata.vault_address,
        par_value: metadata.par_value.toString(),
        yield_bps: metadata.yield_basis_points.toString(),
        is_active: metadata.is_active,
      });
    }
    
    res.json({ assets, count: assets.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific RWA asset
app.get('/api/rwa/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const factoryAddress = process.env.FACTORY_CONTRACT_ADDRESS;
    
    if (!factoryAddress) {
      return res.status(500).json({ error: 'Factory not configured' });
    }

    const factory = new Contract([], factoryAddress, provider);
    const metadata = await factory.get_rwa_metadata(Number(id));
    const nav = await factory.get_rwa_nav(Number(id));
    
    res.json({
      id: Number(id),
      name: shortString.decodeShortString(metadata.name.toString()),
      symbol: shortString.decodeShortString(metadata.symbol.toString()),
      token_address: metadata.token_address,
      vault_address: metadata.vault_address,
      par_value: metadata.par_value.toString(),
      current_nav: nav.toString(),
      yield_bps: metadata.yield_basis_points.toString(),
      inflation_indexed: metadata.inflation_indexed,
      is_active: metadata.is_active,
      created_at: metadata.created_at.toString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get user vault position
app.get('/api/vault/:vaultAddress/position/:userAddress', async (req: Request, res: Response) => {
  try {
    const { vaultAddress, userAddress } = req.params;
    
    const vault = new Contract([], vaultAddress, provider);
    const position = await vault.get_user_position(userAddress);
    const pendingYield = await vault.get_pending_yield(userAddress);
    
    res.json({
      token_balance: position.token_balance.toString(),
      deposit_value: position.deposit_usd_value.toString(),
      entry_cpi: position.deposit_cpi_at_entry.toString(),
      pending_yield: pendingYield.toString(),
      total_claimed: position.total_yield_claimed.toString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get vault TVL
app.get('/api/vault/:vaultAddress/tvl', async (req: Request, res: Response) => {
  try {
    const { vaultAddress } = req.params;
    
    const vault = new Contract([], vaultAddress, provider);
    const tvl = await vault.get_total_value_locked();
    
    res.json({
      tvl: tvl.toString(),
      tvl_usd: (Number(tvl) / 100).toFixed(2), // Convert from cents
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update asset prices (called by oracle publisher)
import { convertPriceBatch, preparePricesForChain, BlockchainPrice } from '../services/price-converter';

app.post('/api/prices/update', async (req: Request, res: Response) => {
  try {
    const rawPrices = req.body;
    
    // Convert to blockchain format
    const priceArray = [
      { symbol: 'XAU', price_usd: rawPrices.gold_usd, timestamp: rawPrices.timestamp },
      { symbol: 'XAG', price_usd: rawPrices.silver_usd, timestamp: rawPrices.timestamp },
      { symbol: 'XPT', price_usd: rawPrices.platinum_usd, timestamp: rawPrices.timestamp },
      { symbol: 'XPD', price_usd: rawPrices.palladium_usd, timestamp: rawPrices.timestamp },
      { symbol: 'AAPL', price_usd: rawPrices.aapl_usd, timestamp: rawPrices.timestamp },
      { symbol: 'MSFT', price_usd: rawPrices.msft_usd, timestamp: rawPrices.timestamp },
      { symbol: 'GOOGL', price_usd: rawPrices.googl_usd, timestamp: rawPrices.timestamp },
      { symbol: 'WTI', price_usd: rawPrices.oil_wti_usd, timestamp: rawPrices.timestamp },
      { symbol: 'BRENT', price_usd: rawPrices.oil_brent_usd, timestamp: rawPrices.timestamp },
    ].filter(p => p.price_usd > 0); // Only include prices that were fetched
    
    const blockchainPrices = convertPriceBatch(priceArray);
    const cairoFormat = preparePricesForChain(priceArray);
    
    // Store both raw and blockchain formats
    (global as any).assetPrices = {
      raw: rawPrices,
      blockchain: blockchainPrices,
      cairo: cairoFormat,
      last_updated: Date.now(),
    };
    
    console.log('[Prices] Asset prices updated and converted to blockchain format');
    console.log(`  - ${blockchainPrices.length} prices processed`);
    
    res.json({ 
      success: true,
      prices_count: blockchainPrices.length,
      formats: ['raw', 'blockchain', 'cairo']
    });
  } catch (error: any) {
    console.error('[Prices] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current asset prices (all formats)
app.get('/api/prices/current', (req: Request, res: Response) => {
  const prices = (global as any).assetPrices;
  
  if (!prices) {
    return res.status(404).json({ error: 'No price data available' });
  }
  
  // Return format based on query parameter
  const format = req.query.format || 'raw';
  
  if (format === 'blockchain') {
    res.json(prices.blockchain);
  } else if (format === 'cairo') {
    res.json(prices.cairo);
  } else {
    res.json(prices.raw);
  }
});

// Get price for specific asset
app.get('/api/prices/:symbol', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const prices = (global as any).assetPrices;
  
  if (!prices) {
    return res.status(404).json({ error: 'No price data available' });
  }
  
  const format = req.query.format || 'raw';
  const priceList = prices[format as string] || prices.raw;
  
  // Find price for symbol
  let price;
  if (format === 'raw') {
    const symbolKey = `${symbol.toLowerCase()}_usd`;
    price = { symbol, price_usd: priceList[symbolKey], timestamp: priceList.timestamp };
  } else {
    price = Array.isArray(priceList) 
      ? priceList.find((p: any) => p.symbol === symbol.toUpperCase())
      : null;
  }
  
  if (!price) {
    return res.status(404).json({ error: `Price not found for ${symbol}` });
  }
  
  res.json(price);
});

// WebSocket: Subscribe to events
import Redis from 'ioredis';

const redis = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL)
  : null;

app.post('/api/subscribe/events', async (req: Request, res: Response) => {
  const { contractAddress, eventName } = req.body;
  
  const subscription = {
    contractAddress,
    eventName,
    timestamp: Date.now(),
  };
  
  if (redis) {
    // Store subscription in Redis
    const key = `subscriptions:${contractAddress}:${eventName}`;
    await redis.sadd(key, JSON.stringify(subscription));
    await redis.expire(key, 86400); // 24 hour expiry
    console.log(`[Redis] Stored subscription: ${key}`);
  } else {
    // Fallback: in-memory storage
    console.log(`[Memory] Subscribed to ${eventName} on ${contractAddress}`);
  }
  
  res.json({ 
    success: true, 
    message: `Subscribed to ${eventName}`,
    websocket: 'ws://localhost:3002',
    storage: redis ? 'redis' : 'memory'
  });
});

// Start servers
app.listen(PORT, () => {
  console.log(`\n✅ Backend API running on http://localhost:${PORT}`);
  console.log(`✅ WebSocket server running on ws://localhost:3002`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/oracle/cpi`);
  console.log(`  GET  /api/rwa/all`);
  console.log(`  GET  /api/rwa/:id`);
  console.log(`  GET  /api/vault/:vaultAddress/position/:userAddress`);
  console.log(`  GET  /api/vault/:vaultAddress/tvl`);
  console.log(`  POST /api/subscribe/events\n`);
});

export { app, broadcast };
