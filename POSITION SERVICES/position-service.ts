/**
 * POSITION SERVICE - COMPLETE IMPLEMENTATION
 * Manages put option positions, calculates P&L, handles expiry
 * Port: 3002
 * Install: npm install express pg amqplib axios
 */

import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import amqp from 'amqplib';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = 3002;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'positions_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

let rabbitChannel: amqp.Channel;

async function initConnections() {
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  await rabbitChannel.assertQueue('position_events', { durable: true });
  await rabbitChannel.bindQueue('position_events', 'trading_events', 'market.price_update');
  await rabbitChannel.bindQueue('position_events', 'trading_events', 'position.#');
  
  console.log('✓ Connected to RabbitMQ');
  
  // Listen for market price updates to recalculate P&L
  rabbitChannel.consume('position_events', async (msg) => {
    if (msg) {
      const event = JSON.parse(msg.content.toString());
      
      if (event.type === 'market.price_update') {
        await updatePositionProfitLoss(event.symbol, event.currentPrice);
      }
      
      rabbitChannel.ack(msg);
    }
  });
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS positions (
      position_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL,
      user_id UUID NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      option_type VARCHAR(4) DEFAULT 'PUT' CHECK (option_type IN ('CALL', 'PUT')),
      strike_price DECIMAL(10,2) NOT NULL CHECK (strike_price > 0),
      premium DECIMAL(10,4) NOT NULL CHECK (premium >= 0),
      contracts INTEGER NOT NULL CHECK (contracts > 0),
      quantity INTEGER NOT NULL DEFAULT 0,
      expiry_date DATE NOT NULL,
      status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'EXERCISED', 'EXPIRED', 'CLOSED')),
      opened_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP,
      avg_entry_price DECIMAL(10,4),
      current_price DECIMAL(10,4),
      unrealized_pnl DECIMAL(18,2) DEFAULT 0,
      realized_pnl DECIMAL(18,2) DEFAULT 0,
      total_cost DECIMAL(18,2) NOT NULL,
      breakeven_price DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS position_history (
      history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      position_id UUID NOT NULL REFERENCES positions(position_id),
      event_type VARCHAR(50) NOT NULL,
      contracts_changed INTEGER,
      price_at_event DECIMAL(10,4),
      pnl_at_event DECIMAL(18,2),
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
    CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_expiry ON positions(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_history_position ON position_history(position_id);
  `);
  
  console.log('✓ Position Service database initialized');
}

// Middleware: Verify user (simplified - in production, verify JWT)
function authenticateToken(req: any, res: Response, next: NextFunction) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' });
  }
  req.userId = userId;
  next();
}

// Calculate put option value and P&L
function calculatePutOptionPL(strikePrice: number, currentPrice: number, premium: number, contracts: number) {
  // Put option intrinsic value: max(strike - current, 0)
  const intrinsicValue = Math.max(strikePrice - currentPrice, 0);
  
  // Value per share
  const valuePerShare = intrinsicValue;
  
  // Total position value (100 shares per contract)
  const totalValue = valuePerShare * contracts * 100;
  
  // Cost basis
  const costBasis = premium * contracts * 100;
  
  // Unrealized P&L
  const unrealizedPL = totalValue - costBasis;
  
  // Breakeven
  const breakeven = strikePrice - premium;
  
  return {
    intrinsicValue,
    totalValue,
    costBasis,
    unrealizedPL,
    breakeven,
    profitPercent: costBasis > 0 ? (unrealizedPL / costBasis) * 100 : 0
  };
}

// ==================== POSITION ENDPOINTS ====================

// POST /positions - Create new put option position
app.post('/positions', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const { accountId, symbol, strikePrice, premium, contracts, expiryDate } = req.body;
    const userId = req.userId;

    if (!accountId || !symbol || !strikePrice || !premium || !contracts || !expiryDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate expiry date is in future
    const expiry = new Date(expiryDate);
    if (expiry <= new Date()) {
      return res.status(400).json({ error: 'Expiry date must be in the future' });
    }

    // Calculate total cost
    const totalCost = premium * contracts * 100;

    // Check user has sufficient buying power via User Service
    const userResponse = await axios.get(`http://localhost:3001/users/${userId}`);
    const buyingPower = userResponse.data.account.buyingPower;

    if (buyingPower < totalCost) {
      return res.status(400).json({ error: 'Insufficient buying power' });
    }

    // Get current market price from Market Data Service
    const marketResponse = await axios.get(`http://localhost:3004/market/${symbol}/price`);
    const currentPrice = marketResponse.data.currentPrice;

    // Calculate breakeven
    const breakeven = strikePrice - premium;

    // Calculate initial P&L
    const plCalc = calculatePutOptionPL(strikePrice, currentPrice, premium, contracts);

    await client.query('BEGIN');

    // Create position
    const positionResult = await client.query(
      `INSERT INTO positions (
        account_id, user_id, symbol, option_type, strike_price, premium,
        contracts, quantity, expiry_date, status, avg_entry_price, current_price,
        unrealized_pnl, total_cost, breakeven_price
      ) VALUES ($1, $2, $3, 'PUT', $4, $5, $6, $7, $8, 'ACTIVE', $9, $10, $11, $12, $13)
      RETURNING position_id, created_at`,
      [
        accountId, userId, symbol, strikePrice, premium, contracts,
        contracts, expiryDate, premium, currentPrice, plCalc.unrealizedPL,
        totalCost, breakeven
      ]
    );

    const positionId = positionResult.rows[0].position_id;

    // Record in history
    await client.query(
      `INSERT INTO position_history (position_id, event_type, contracts_changed, price_at_event, details)
       VALUES ($1, 'POSITION_OPENED', $2, $3, $4)`,
      [positionId, contracts, currentPrice, JSON.stringify({ strikePrice, premium, expiryDate })]
    );

    await client.query('COMMIT');

    // Deduct from user balance via User Service
    await axios.post(`http://localhost:3001/accounts/${accountId}/debit`, {
      amount: totalCost,
      description: `Put option purchase: ${contracts} contracts ${symbol} @ $${strikePrice}`,
      referenceId: positionId
    });

    // Publish event for AI analysis
    rabbitChannel.publish(
      'trading_events',
      'position.created',
      Buffer.from(JSON.stringify({
        type: 'position.created',
        data: {
          positionId,
          userId,
          symbol,
          strikePrice,
          premium,
          contracts,
          expiryDate,
          currentPrice,
          totalCost
        },
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Position created: ${contracts} ${symbol} PUT @ $${strikePrice}`);

    res.status(201).json({
      success: true,
      position: {
        positionId,
        symbol,
        optionType: 'PUT',
        strikePrice,
        premium,
        contracts,
        expiryDate,
        currentPrice,
        totalCost,
        breakeven,
        unrealizedPL: plCalc.unrealizedPL,
        profitPercent: plCalc.profitPercent,
        status: 'ACTIVE',
        createdAt: positionResult.rows[0].created_at
      }
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create position error:', error);
    res.status(500).json({ error: error.message || 'Failed to create position' });
  } finally {
    client.release();
  }
});

// GET /positions - List user's positions
app.get('/positions', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    const { status, symbol } = req.query;

    let query = `
      SELECT position_id, symbol, option_type, strike_price, premium, contracts,
             expiry_date, status, current_price, unrealized_pnl, realized_pnl,
             total_cost, breakeven_price, opened_at, closed_at
      FROM positions
      WHERE user_id = $1
    `;
    const params: any[] = [userId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (symbol) {
      query += ` AND symbol = $${paramIndex}`;
      params.push(symbol);
    }

    query += ` ORDER BY opened_at DESC`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      positions: result.rows.map(p => ({
        positionId: p.position_id,
        symbol: p.symbol,
        optionType: p.option_type,
        strikePrice: parseFloat(p.strike_price),
        premium: parseFloat(p.premium),
        contracts: p.contracts,
        expiryDate: p.expiry_date,
        status: p.status,
        currentPrice: parseFloat(p.current_price),
        unrealizedPL: parseFloat(p.unrealized_pnl),
        realizedPL: parseFloat(p.realized_pnl),
        totalCost: parseFloat(p.total_cost),
        breakeven: parseFloat(p.breakeven_price),
        openedAt: p.opened_at,
        closedAt: p.closed_at
      }))
    });

  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({ error: 'Failed to retrieve positions' });
  }
});

// GET /positions/:positionId - Get specific position
app.get('/positions/:positionId', authenticateToken, async (req: any, res: Response) => {
  try {
    const { positionId } = req.params;
    const userId = req.userId;

    const result = await db.query(
      `SELECT * FROM positions WHERE position_id = $1 AND user_id = $2`,
      [positionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Position not found' });
    }

    const p = result.rows[0];

    // Get position history
    const historyResult = await db.query(
      `SELECT event_type, contracts_changed, price_at_event, pnl_at_event, details, created_at
       FROM position_history
       WHERE position_id = $1
       ORDER BY created_at DESC`,
      [positionId]
    );

    res.json({
      success: true,
      position: {
        positionId: p.position_id,
        accountId: p.account_id,
        symbol: p.symbol,
        optionType: p.option_type,
        strikePrice: parseFloat(p.strike_price),
        premium: parseFloat(p.premium),
        contracts: p.contracts,
        quantity: p.quantity,
        expiryDate: p.expiry_date,
        status: p.status,
        avgEntryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPL: parseFloat(p.unrealized_pnl),
        realizedPL: parseFloat(p.realized_pnl),
        totalCost: parseFloat(p.total_cost),
        breakeven: parseFloat(p.breakeven_price),
        openedAt: p.opened_at,
        closedAt: p.closed_at
      },
      history: historyResult.rows
    });

  } catch (error) {
    console.error('Get position error:', error);
    res.status(500).json({ error: 'Failed to retrieve position' });
  }
});

// PUT /positions/:positionId/close - Close position
app.put('/positions/:positionId/close', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const { positionId } = req.params;
    const userId = req.userId;
    const { sellPrice } = req.body;

    await client.query('BEGIN');

    const positionResult = await client.query(
      `SELECT * FROM positions WHERE position_id = $1 AND user_id = $2 FOR UPDATE`,
      [positionId, userId]
    );

    if (positionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Position not found' });
    }

    const position = positionResult.rows[0];

    if (position.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Position is not active' });
    }

    // Calculate realized P&L
    const proceeds = sellPrice * position.contracts * 100;
    const realizedPL = proceeds - parseFloat(position.total_cost);

    // Update position
    await client.query(
      `UPDATE positions
       SET status = 'CLOSED',
           closed_at = NOW(),
           realized_pnl = $1,
           unrealized_pnl = 0,
           updated_at = NOW()
       WHERE position_id = $2`,
      [realizedPL, positionId]
    );

    // Record in history
    await client.query(
      `INSERT INTO position_history (position_id, event_type, price_at_event, pnl_at_event, details)
       VALUES ($1, 'POSITION_CLOSED', $2, $3, $4)`,
      [positionId, sellPrice, realizedPL, JSON.stringify({ proceeds, sellPrice })]
    );

    await client.query('COMMIT');

    // Credit user account
    await axios.post(`http://localhost:3001/accounts/${position.account_id}/credit`, {
      amount: proceeds,
      description: `Put option sale: ${position.contracts} contracts ${position.symbol}`,
      referenceId: positionId
    });

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'position.closed',
      Buffer.from(JSON.stringify({
        positionId,
        userId,
        symbol: position.symbol,
        realizedPL,
        proceeds,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Position closed: ${positionId} | P&L: $${realizedPL.toFixed(2)}`);

    res.json({
      success: true,
      position: {
        positionId,
        status: 'CLOSED',
        sellPrice,
        proceeds,
        realizedPL,
        closedAt: new Date()
      }
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Close position error:', error);
    res.status(500).json({ error: 'Failed to close position' });
  } finally {
    client.release();
  }
});

// Background task: Update position P&L when market prices change
async function updatePositionProfitLoss(symbol: string, currentPrice: number) {
  try {
    const result = await db.query(
      `SELECT position_id, strike_price, premium, contracts, total_cost
       FROM positions
       WHERE symbol = $1 AND status = 'ACTIVE'`,
      [symbol]
    );

    for (const position of result.rows) {
      const plCalc = calculatePutOptionPL(
        parseFloat(position.strike_price),
        currentPrice,
        parseFloat(position.premium),
        position.contracts
      );

      await db.query(
        `UPDATE positions
         SET current_price = $1,
             unrealized_pnl = $2,
             updated_at = NOW()
         WHERE position_id = $3`,
        [currentPrice, plCalc.unrealizedPL, position.position_id]
      );

      // Record price update in history
      await db.query(
        `INSERT INTO position_history (position_id, event_type, price_at_event, pnl_at_event)
         VALUES ($1, 'PRICE_UPDATE', $2, $3)`,
        [position.position_id, currentPrice, plCalc.unrealizedPL]
      );
    }

    console.log(`✓ Updated P&L for ${result.rows.length} ${symbol} positions`);

  } catch (error) {
    console.error('Update P&L error:', error);
  }
}

// Background task: Handle position expiry
async function checkExpiredPositions() {
  try {
    const result = await db.query(
      `SELECT position_id, user_id, symbol, strike_price, contracts, total_cost, account_id
       FROM positions
       WHERE status = 'ACTIVE' AND expiry_date < CURRENT_DATE`
    );

    for (const position of result.rows) {
      // Get current market price
      const marketResponse = await axios.get(`http://localhost:3004/market/${position.symbol}/price`);
      const currentPrice = marketResponse.data.currentPrice;

      // Calculate if in-the-money
      const intrinsicValue = Math.max(parseFloat(position.strike_price) - currentPrice, 0);

      let realizedPL: number;
      let status: string;

      if (intrinsicValue > 0) {
        // In the money - exercise
        const proceeds = intrinsicValue * position.contracts * 100;
        realizedPL = proceeds - parseFloat(position.total_cost);
        status = 'EXERCISED';

        // Credit user account
        await axios.post(`http://localhost:3001/accounts/${position.account_id}/credit`, {
          amount: proceeds,
          description: `Put option exercised: ${position.contracts} contracts ${position.symbol}`,
          referenceId: position.position_id
        });

      } else {
        // Out of the money - expire worthless
        realizedPL = -parseFloat(position.total_cost);
        status = 'EXPIRED';
      }

      // Update position
      await db.query(
        `UPDATE positions
         SET status = $1,
             realized_pnl = $2,
             unrealized_pnl = 0,
             closed_at = NOW(),
             updated_at = NOW()
         WHERE position_id = $3`,
        [status, realizedPL, position.position_id]
      );

      // Record in history
      await db.query(
        `INSERT INTO position_history (position_id, event_type, price_at_event, pnl_at_event)
         VALUES ($1, $2, $3, $4)`,
        [position.position_id, status, currentPrice, realizedPL]
      );

      // Publish event
      rabbitChannel.publish(
        'trading_events',
        `position.${status.toLowerCase()}`,
        Buffer.from(JSON.stringify({
          positionId: position.position_id,
          userId: position.user_id,
          symbol: position.symbol,
          realizedPL,
          status,
          timestamp: new Date().toISOString()
        }))
      );

      console.log(`✓ Position ${status}: ${position.position_id} | P&L: $${realizedPL.toFixed(2)}`);
    }

  } catch (error) {
    console.error('Check expired positions error:', error);
  }
}

// Run expiry check every hour
setInterval(checkExpiredPositions, 60 * 60 * 1000);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Position Service',
    status: 'healthy',
    database: 'connected',
    rabbitmq: 'connected',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Start service
async function start() {
  try {
    await initDatabase();
    await initConnections();

    app.listen(PORT, () => {
      console.log(`\n🚀 Position Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ RabbitMQ connected`);
      console.log(`✓ Expiry checker running\n`);
    });

    // Run expiry check on startup
    await checkExpiredPositions();

  } catch (error) {
    console.error('Failed to start Position Service:', error);
    process.exit(1);
  }
}

start();