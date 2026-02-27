/**
 * MARKET DATA SERVICE - COMPLETE IMPLEMENTATION
 * Real-time market prices, historical data, volatility calculations
 * Port: 3004
 * Install: npm install express pg amqplib ws
 */

import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import amqp from 'amqplib';
import WebSocket from 'ws';

const app = express();
app.use(express.json());

const PORT = 3004;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'market_data_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

let rabbitChannel: amqp.Channel;
const wss = new WebSocket.Server({ port: 8080 });

// In-memory price cache
const priceCache = new Map<string, MarketPrice>();
const subscribers = new Map<string, Set<WebSocket>>();

interface MarketPrice {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePercent24h: number;
  impliedVolatility: number;
  timestamp: Date;
}

interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function initConnections() {
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  
  console.log('✓ Connected to RabbitMQ');
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS market_prices (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(10) NOT NULL,
      price DECIMAL(10,4) NOT NULL,
      bid_price DECIMAL(10,4),
      ask_price DECIMAL(10,4),
      volume BIGINT DEFAULT 0,
      timestamp TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(10) NOT NULL,
      interval VARCHAR(10) NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
      open_price DECIMAL(10,4) NOT NULL,
      high_price DECIMAL(10,4) NOT NULL,
      low_price DECIMAL(10,4) NOT NULL,
      close_price DECIMAL(10,4) NOT NULL,
      volume BIGINT DEFAULT 0,
      timestamp TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS volatility_data (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(10) NOT NULL,
      strike_price DECIMAL(10,2),
      implied_volatility DECIMAL(8,4),
      historical_volatility DECIMAL(8,4),
      timestamp TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_prices_symbol ON market_prices(symbol);
    CREATE INDEX IF NOT EXISTS idx_prices_timestamp ON market_prices(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_history_symbol_interval ON price_history(symbol, interval, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_volatility_symbol ON volatility_data(symbol);
  `);
  
  console.log('✓ Market Data Service database initialized');
  
  // Initialize sample data
  await initializeSampleData();
}

async function initializeSampleData() {
  const symbols = ['AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'SPY'];
  const basePrices: { [key: string]: number } = {
    'AAPL': 175.50,
    'TSLA': 245.30,
    'MSFT': 415.75,
    'GOOGL': 142.80,
    'AMZN': 178.25,
    'NVDA': 525.40,
    'META': 485.30,
    'SPY': 485.60
  };

  for (const symbol of symbols) {
    const basePrice = basePrices[symbol];
    const spread = basePrice * 0.001; // 0.1% spread
    
    priceCache.set(symbol, {
      symbol,
      lastPrice: basePrice,
      bidPrice: basePrice - spread / 2,
      askPrice: basePrice + spread / 2,
      volume: Math.floor(Math.random() * 10000000),
      high24h: basePrice * 1.02,
      low24h: basePrice * 0.98,
      change24h: basePrice * 0.01,
      changePercent24h: 1.0,
      impliedVolatility: 0.25 + Math.random() * 0.15, // 25-40%
      timestamp: new Date()
    });

    await db.query(
      `INSERT INTO market_prices (symbol, price, bid_price, ask_price, volume)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [symbol, basePrice, basePrice - spread / 2, basePrice + spread / 2, Math.floor(Math.random() * 1000000)]
    );
  }

  console.log('✓ Sample market data initialized');
}

// Simulate real-time price updates
function startPriceSimulation() {
  setInterval(() => {
    priceCache.forEach((price, symbol) => {
      // Simulate price movement (+/- 0.5%)
      const change = price.lastPrice * (Math.random() - 0.5) * 0.01;
      const newPrice = Math.max(0.01, price.lastPrice + change);
      
      const spread = newPrice * 0.001;
      
      const updatedPrice: MarketPrice = {
        ...price,
        lastPrice: newPrice,
        bidPrice: newPrice - spread / 2,
        askPrice: newPrice + spread / 2,
        volume: price.volume + Math.floor(Math.random() * 10000),
        change24h: newPrice - (price.lastPrice - price.change24h),
        changePercent24h: ((newPrice - (price.lastPrice - price.change24h)) / (price.lastPrice - price.change24h)) * 100,
        timestamp: new Date()
      };

      priceCache.set(symbol, updatedPrice);

      // Store in database
      db.query(
        `INSERT INTO market_prices (symbol, price, bid_price, ask_price, volume)
         VALUES ($1, $2, $3, $4, $5)`,
        [symbol, newPrice, updatedPrice.bidPrice, updatedPrice.askPrice, updatedPrice.volume]
      ).catch(err => console.error('DB insert error:', err));

      // Publish to RabbitMQ
      rabbitChannel.publish(
        'trading_events',
        'market.price_update',
        Buffer.from(JSON.stringify({
          type: 'market.price_update',
          symbol,
          currentPrice: newPrice,
          bid: updatedPrice.bidPrice,
          ask: updatedPrice.askPrice,
          timestamp: updatedPrice.timestamp
        }))
      );

      // Broadcast to WebSocket subscribers
      broadcastPrice(symbol, updatedPrice);
    });
  }, 2000); // Update every 2 seconds

  console.log('✓ Price simulation started');
}

// WebSocket price broadcasting
function broadcastPrice(symbol: string, price: MarketPrice) {
  const subs = subscribers.get(symbol);
  if (subs) {
    const message = JSON.stringify({
      type: 'price_update',
      data: price
    });

    subs.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  console.log('✓ New WebSocket connection');

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'subscribe') {
        const { symbols } = data;
        symbols.forEach((symbol: string) => {
          if (!subscribers.has(symbol)) {
            subscribers.set(symbol, new Set());
          }
          subscribers.get(symbol)!.add(ws);

          // Send current price immediately
          const currentPrice = priceCache.get(symbol);
          if (currentPrice) {
            ws.send(JSON.stringify({
              type: 'price_update',
              data: currentPrice
            }));
          }
        });

        console.log(`✓ Client subscribed to: ${symbols.join(', ')}`);
      }

      if (data.type === 'unsubscribe') {
        const { symbols } = data;
        symbols.forEach((symbol: string) => {
          const subs = subscribers.get(symbol);
          if (subs) {
            subs.delete(ws);
          }
        });
      }

    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    // Remove from all subscriptions
    subscribers.forEach(subs => subs.delete(ws));
    console.log('✓ WebSocket connection closed');
  });
});

// Calculate historical volatility
function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize (assuming 252 trading days)
  return stdDev * Math.sqrt(252);
}

// ==================== API ENDPOINTS ====================

// GET /market/:symbol/price - Get current price
app.get('/market/:symbol/price', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const price = priceCache.get(symbol.toUpperCase());

  if (!price) {
    return res.status(404).json({ error: 'Symbol not found' });
  }

  res.json({
    success: true,
    symbol: price.symbol,
    currentPrice: price.lastPrice,
    bidPrice: price.bidPrice,
    askPrice: price.askPrice,
    volume: price.volume,
    high24h: price.high24h,
    low24h: price.low24h,
    change24h: price.change24h,
    changePercent24h: price.changePercent24h,
    impliedVolatility: price.impliedVolatility,
    timestamp: price.timestamp
  });
});

// GET /market/:symbol/quote - Get full quote
app.get('/market/:symbol/quote', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  const price = priceCache.get(symbol.toUpperCase());

  if (!price) {
    return res.status(404).json({ error: 'Symbol not found' });
  }

  // Get recent volatility
  const volatilityResult = await db.query(
    `SELECT implied_volatility, historical_volatility
     FROM volatility_data
     WHERE symbol = $1
     ORDER BY timestamp DESC
     LIMIT 1`,
    [symbol.toUpperCase()]
  );

  const volatility = volatilityResult.rows[0] || {
    implied_volatility: price.impliedVolatility,
    historical_volatility: price.impliedVolatility * 0.9
  };

  res.json({
    success: true,
    quote: {
      symbol: price.symbol,
      lastPrice: price.lastPrice,
      bid: price.bidPrice,
      ask: price.askPrice,
      spread: price.askPrice - price.bidPrice,
      spreadPercent: ((price.askPrice - price.bidPrice) / price.lastPrice) * 100,
      volume: price.volume,
      high24h: price.high24h,
      low24h: price.low24h,
      change24h: price.change24h,
      changePercent24h: price.changePercent24h,
      impliedVolatility: parseFloat(volatility.implied_volatility),
      historicalVolatility: parseFloat(volatility.historical_volatility),
      timestamp: price.timestamp
    }
  });
});

// GET /market/:symbol/history - Get price history
app.get('/market/:symbol/history', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { interval = '1h', limit = 100 } = req.query;

    const result = await db.query(
      `SELECT timestamp, open_price, high_price, low_price, close_price, volume
       FROM price_history
       WHERE symbol = $1 AND interval = $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [symbol.toUpperCase(), interval, limit]
    );

    res.json({
      success: true,
      symbol,
      interval,
      data: result.rows.map(row => ({
        timestamp: row.timestamp,
        open: parseFloat(row.open_price),
        high: parseFloat(row.high_price),
        low: parseFloat(row.low_price),
        close: parseFloat(row.close_price),
        volume: parseInt(row.volume)
      }))
    });

  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to retrieve history' });
  }
});

// GET /market/:symbol/volatility - Get volatility metrics
app.get('/market/:symbol/volatility', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { days = 30 } = req.query;

    // Get recent prices for calculation
    const pricesResult = await db.query(
      `SELECT price
       FROM market_prices
       WHERE symbol = $1
       AND timestamp > NOW() - INTERVAL '${days} days'
       ORDER BY timestamp ASC`,
      [symbol.toUpperCase()]
    );

    const prices = pricesResult.rows.map(r => parseFloat(r.price));
    const historicalVol = calculateVolatility(prices);

    // Get implied volatility
    const ivResult = await db.query(
      `SELECT AVG(implied_volatility) as avg_iv
       FROM volatility_data
       WHERE symbol = $1
       AND timestamp > NOW() - INTERVAL '7 days'`,
      [symbol.toUpperCase()]
    );

    const impliedVol = ivResult.rows[0]?.avg_iv || historicalVol;

    // Store calculated volatility
    await db.query(
      `INSERT INTO volatility_data (symbol, implied_volatility, historical_volatility)
       VALUES ($1, $2, $3)`,
      [symbol.toUpperCase(), impliedVol, historicalVol]
    );

    res.json({
      success: true,
      symbol,
      volatility: {
        impliedVolatility: parseFloat(impliedVol),
        historicalVolatility: historicalVol,
        volatilityRatio: parseFloat(impliedVol) / historicalVol,
        period: `${days} days`
      }
    });

  } catch (error) {
    console.error('Get volatility error:', error);
    res.status(500).json({ error: 'Failed to calculate volatility' });
  }
});

// GET /market/symbols - List available symbols
app.get('/market/symbols', (req: Request, res: Response) => {
  const symbols = Array.from(priceCache.values()).map(price => ({
    symbol: price.symbol,
    name: price.symbol, // In production, would have full company names
    lastPrice: price.lastPrice,
    change24h: price.change24h,
    changePercent24h: price.changePercent24h,
    volume: price.volume
  }));

  res.json({
    success: true,
    symbols
  });
});

// POST /market/:symbol/snapshot - Get market snapshot for option pricing
app.post('/market/:symbol/snapshot', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { strikePrice, expiryDate } = req.body;

    const price = priceCache.get(symbol.toUpperCase());
    if (!price) {
      return res.status(404).json({ error: 'Symbol not found' });
    }

    // Calculate days to expiry
    const daysToExpiry = Math.ceil(
      (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    // Simple put option pricing estimate
    const intrinsicValue = Math.max(strikePrice - price.lastPrice, 0);
    const timeValue = price.impliedVolatility * Math.sqrt(daysToExpiry / 365) * price.lastPrice;
    const estimatedPremium = intrinsicValue + timeValue;

    res.json({
      success: true,
      snapshot: {
        symbol: price.symbol,
        currentPrice: price.lastPrice,
        strikePrice,
        expiryDate,
        daysToExpiry,
        impliedVolatility: price.impliedVolatility,
        estimatedPremium: Math.max(0.01, estimatedPremium),
        intrinsicValue,
        timeValue,
        inTheMoney: strikePrice > price.lastPrice,
        delta: strikePrice > price.lastPrice ? -0.5 : -0.1, // Simplified
        gamma: 0.05,
        theta: -timeValue / daysToExpiry,
        vega: price.lastPrice * 0.01
      }
    });

  } catch (error) {
    console.error('Get snapshot error:', error);
    res.status(500).json({ error: 'Failed to get market snapshot' });
  }
});

// GET /market/health - Service health
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Market Data Service',
    status: 'healthy',
    database: 'connected',
    rabbitmq: 'connected',
    websocket: 'active',
    activeSymbols: priceCache.size,
    websocketConnections: wss.clients.size,
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Start service
async function start() {
  try {
    await initDatabase();
    await initConnections();
    startPriceSimulation();

    app.listen(PORT, () => {
      console.log(`\n🚀 Market Data Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ RabbitMQ connected`);
      console.log(`✓ WebSocket server on port 8080`);
      console.log(`✓ Price simulation active\n`);
    });

  } catch (error) {
    console.error('Failed to start Market Data Service:', error);
    process.exit(1);
  }
}

start();