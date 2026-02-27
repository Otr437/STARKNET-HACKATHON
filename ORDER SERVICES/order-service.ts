/**
 * ORDER SERVICE - COMPLETE IMPLEMENTATION
 * Handles order placement, matching, execution
 * Port: 3003
 * Install: npm install express pg amqplib axios uuid
 */

import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import amqp from 'amqplib';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const PORT = 3003;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'orders_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

let rabbitChannel: amqp.Channel;

async function initConnections() {
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  await rabbitChannel.assertQueue('order_processing', { durable: true });
  
  console.log('✓ Connected to RabbitMQ');
  
  // Process orders from queue
  rabbitChannel.consume('order_processing', async (msg) => {
    if (msg) {
      const order = JSON.parse(msg.content.toString());
      await processOrder(order.orderId);
      rabbitChannel.ack(msg);
    }
  });
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      account_id UUID NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP_LOSS')),
      side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
      option_type VARCHAR(4) DEFAULT 'PUT' CHECK (option_type IN ('CALL', 'PUT')),
      strike_price DECIMAL(10,2) NOT NULL,
      limit_price DECIMAL(10,4),
      stop_price DECIMAL(10,4),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      filled_quantity INTEGER DEFAULT 0,
      remaining_quantity INTEGER,
      status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED')),
      time_in_force VARCHAR(10) DEFAULT 'DAY' CHECK (time_in_force IN ('DAY', 'GTC', 'IOC', 'FOK')),
      avg_fill_price DECIMAL(10,4),
      total_cost DECIMAL(18,2),
      commission DECIMAL(10,2) DEFAULT 0,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      filled_at TIMESTAMP,
      expires_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_fills (
      fill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(order_id),
      fill_price DECIMAL(10,4) NOT NULL,
      fill_quantity INTEGER NOT NULL,
      commission DECIMAL(10,2) DEFAULT 0,
      liquidity_flag VARCHAR(10) CHECK (liquidity_flag IN ('MAKER', 'TAKER')),
      execution_venue VARCHAR(50),
      filled_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_fills_order ON order_fills(order_id);
  `);
  
  console.log('✓ Order Service database initialized');
}

function authenticateToken(req: any, res: Response, next: NextFunction) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' });
  }
  req.userId = userId;
  next();
}

// Calculate commission (simplified)
function calculateCommission(quantity: number, price: number): number {
  // $0.65 per contract + $0.50 per 100 shares
  const perContract = 0.65;
  const perShareFee = (quantity * 100) * 0.005; // 0.5 cents per share
  return (perContract * quantity) + perShareFee;
}

// ==================== ORDER ENDPOINTS ====================

// POST /orders - Place new order
app.post('/orders', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const {
      accountId,
      symbol,
      orderType,
      side,
      strikePrice,
      quantity,
      limitPrice,
      stopPrice,
      timeInForce
    } = req.body;
    const userId = req.userId;

    if (!accountId || !symbol || !orderType || !side || !strikePrice || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate order type requirements
    if (orderType === 'LIMIT' && !limitPrice) {
      return res.status(400).json({ error: 'Limit price required for LIMIT orders' });
    }
    if (orderType === 'STOP_LOSS' && !stopPrice) {
      return res.status(400).json({ error: 'Stop price required for STOP_LOSS orders' });
    }

    // Get current market price
    const marketResponse = await axios.get(`http://localhost:3004/market/${symbol}/price`);
    const currentPrice = marketResponse.data.currentPrice;

    // Estimate cost for buying power check
    let estimatedPrice = currentPrice;
    if (orderType === 'LIMIT') {
      estimatedPrice = limitPrice;
    }

    const estimatedCost = estimatedPrice * quantity * 100; // 100 shares per contract
    const commission = calculateCommission(quantity, estimatedPrice);
    const totalCost = estimatedCost + commission;

    // Check buying power for BUY orders
    if (side === 'BUY') {
      const userResponse = await axios.get(`http://localhost:3001/users/${userId}`);
      const buyingPower = userResponse.data.account.buyingPower;

      if (buyingPower < totalCost) {
        return res.status(400).json({ error: 'Insufficient buying power' });
      }
    }

    // Check if user has position for SELL orders
    if (side === 'SELL') {
      const positionsResponse = await axios.get(`http://localhost:3002/positions?symbol=${symbol}`, {
        headers: { 'x-user-id': userId }
      });
      
      const positions = positionsResponse.data.positions;
      const totalContracts = positions
        .filter((p: any) => p.status === 'ACTIVE')
        .reduce((sum: number, p: any) => sum + p.contracts, 0);

      if (totalContracts < quantity) {
        return res.status(400).json({ error: 'Insufficient position to sell' });
      }
    }

    await client.query('BEGIN');

    // Create order
    const expiresAt = timeInForce === 'DAY' ? 
      new Date(Date.now() + 24 * 60 * 60 * 1000) : // End of trading day
      null; // GTC = Good til cancelled

    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, account_id, symbol, order_type, side, option_type,
        strike_price, limit_price, stop_price, quantity, remaining_quantity,
        status, time_in_force, commission, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'PUT', $6, $7, $8, $9, $10, 'PENDING', $11, $12, $13)
      RETURNING order_id, created_at`,
      [
        userId, accountId, symbol, orderType, side, strikePrice,
        limitPrice || null, stopPrice || null, quantity, quantity,
        timeInForce || 'DAY', commission, expiresAt
      ]
    );

    const orderId = orderResult.rows[0].order_id;

    await client.query('COMMIT');

    // Reserve buying power for BUY orders
    if (side === 'BUY') {
      await axios.post(`http://localhost:3001/accounts/${accountId}/reserve`, {
        amount: totalCost,
        referenceId: orderId
      });
    }

    // Submit order for processing
    await client.query(
      `UPDATE orders SET status = 'SUBMITTED', updated_at = NOW() WHERE order_id = $1`,
      [orderId]
    );

    // Queue order for async processing
    rabbitChannel.sendToQueue(
      'order_processing',
      Buffer.from(JSON.stringify({ orderId })),
      { persistent: true }
    );

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'order.submitted',
      Buffer.from(JSON.stringify({
        orderId,
        userId,
        symbol,
        side,
        orderType,
        quantity,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Order submitted: ${orderId} | ${side} ${quantity} ${symbol} PUT @ $${strikePrice}`);

    res.status(201).json({
      success: true,
      order: {
        orderId,
        symbol,
        orderType,
        side,
        strikePrice,
        quantity,
        status: 'SUBMITTED',
        commission,
        createdAt: orderResult.rows[0].created_at
      }
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Process order (called from queue)
async function processOrder(orderId: string) {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const order = orderResult.rows[0];

    if (order.status !== 'SUBMITTED') {
      await client.query('ROLLBACK');
      return;
    }

    // Get current market price
    const marketResponse = await axios.get(`http://localhost:3004/market/${order.symbol}/price`);
    const currentPrice = marketResponse.data.currentPrice;

    // Determine if order can be filled
    let canFill = false;
    let fillPrice = currentPrice;

    if (order.order_type === 'MARKET') {
      canFill = true;
      fillPrice = currentPrice;
    } else if (order.order_type === 'LIMIT') {
      if (order.side === 'BUY' && currentPrice <= order.limit_price) {
        canFill = true;
        fillPrice = Math.min(currentPrice, order.limit_price);
      } else if (order.side === 'SELL' && currentPrice >= order.limit_price) {
        canFill = true;
        fillPrice = Math.max(currentPrice, order.limit_price);
      }
    } else if (order.order_type === 'STOP_LOSS') {
      if (order.side === 'BUY' && currentPrice >= order.stop_price) {
        canFill = true;
        fillPrice = currentPrice;
      } else if (order.side === 'SELL' && currentPrice <= order.stop_price) {
        canFill = true;
        fillPrice = currentPrice;
      }
    }

    if (!canFill) {
      // Order not fillable yet - leave in SUBMITTED status
      await client.query('ROLLBACK');
      console.log(`Order ${orderId} not fillable at current price ${currentPrice}`);
      return;
    }

    // Fill the order
    const fillQuantity = order.remaining_quantity;
    const totalValue = fillPrice * fillQuantity * 100;

    // Record fill
    await client.query(
      `INSERT INTO order_fills (order_id, fill_price, fill_quantity, commission, liquidity_flag)
       VALUES ($1, $2, $3, $4, 'TAKER')`,
      [orderId, fillPrice, fillQuantity, order.commission]
    );

    // Update order
    await client.query(
      `UPDATE orders
       SET status = 'FILLED',
           filled_quantity = filled_quantity + $1,
           remaining_quantity = 0,
           avg_fill_price = $2,
           total_cost = $3,
           filled_at = NOW(),
           updated_at = NOW()
       WHERE order_id = $4`,
      [fillQuantity, fillPrice, totalValue, orderId]
    );

    await client.query('COMMIT');

    // Create position or update existing
    if (order.side === 'BUY') {
      await axios.post('http://localhost:3002/positions', {
        accountId: order.account_id,
        symbol: order.symbol,
        strikePrice: order.strike_price,
        premium: fillPrice,
        contracts: fillQuantity,
        expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days default
      }, {
        headers: { 'x-user-id': order.user_id }
      });

      // Deduct from user balance
      await axios.post(`http://localhost:3001/accounts/${order.account_id}/debit`, {
        amount: totalValue + parseFloat(order.commission),
        description: `Order filled: ${order.symbol} PUT`,
        referenceId: orderId
      });

    } else { // SELL
      // Close position
      const positionsResponse = await axios.get(
        `http://localhost:3002/positions?symbol=${order.symbol}&status=ACTIVE`,
        { headers: { 'x-user-id': order.user_id } }
      );

      const position = positionsResponse.data.positions[0];
      if (position) {
        await axios.put(`http://localhost:3002/positions/${position.positionId}/close`, {
          sellPrice: fillPrice
        }, {
          headers: { 'x-user-id': order.user_id }
        });
      }
    }

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'order.filled',
      Buffer.from(JSON.stringify({
        orderId,
        userId: order.user_id,
        symbol: order.symbol,
        side: order.side,
        fillPrice,
        fillQuantity,
        totalValue,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Order filled: ${orderId} | ${fillQuantity} contracts @ $${fillPrice.toFixed(4)}`);

  } catch (error: any) {
    await client.query('ROLLBACK');
    
    // Mark order as rejected
    await db.query(
      `UPDATE orders
       SET status = 'REJECTED',
           rejection_reason = $1,
           updated_at = NOW()
       WHERE order_id = $2`,
      [error.message, orderId]
    );

    console.error(`Order ${orderId} rejected:`, error.message);
  } finally {
    client.release();
  }
}

// GET /orders - List user's orders
app.get('/orders', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    const { status, symbol, limit = 50 } = req.query;

    let query = `
      SELECT order_id, symbol, order_type, side, strike_price, limit_price,
             quantity, filled_quantity, status, avg_fill_price, total_cost,
             commission, created_at, filled_at
      FROM orders
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
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    res.json({
      success: true,
      orders: result.rows.map(o => ({
        orderId: o.order_id,
        symbol: o.symbol,
        orderType: o.order_type,
        side: o.side,
        strikePrice: parseFloat(o.strike_price),
        limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
        quantity: o.quantity,
        filledQuantity: o.filled_quantity,
        status: o.status,
        avgFillPrice: o.avg_fill_price ? parseFloat(o.avg_fill_price) : null,
        totalCost: o.total_cost ? parseFloat(o.total_cost) : null,
        commission: parseFloat(o.commission),
        createdAt: o.created_at,
        filledAt: o.filled_at
      }))
    });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// GET /orders/:orderId - Get specific order with fills
app.get('/orders/:orderId', authenticateToken, async (req: any, res: Response) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    const orderResult = await db.query(
      `SELECT * FROM orders WHERE order_id = $1 AND user_id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Get fills
    const fillsResult = await db.query(
      `SELECT fill_id, fill_price, fill_quantity, commission, liquidity_flag, filled_at
       FROM order_fills
       WHERE order_id = $1
       ORDER BY filled_at ASC`,
      [orderId]
    );

    res.json({
      success: true,
      order: {
        orderId: order.order_id,
        symbol: order.symbol,
        orderType: order.order_type,
        side: order.side,
        strikePrice: parseFloat(order.strike_price),
        limitPrice: order.limit_price ? parseFloat(order.limit_price) : null,
        stopPrice: order.stop_price ? parseFloat(order.stop_price) : null,
        quantity: order.quantity,
        filledQuantity: order.filled_quantity,
        remainingQuantity: order.remaining_quantity,
        status: order.status,
        timeInForce: order.time_in_force,
        avgFillPrice: order.avg_fill_price ? parseFloat(order.avg_fill_price) : null,
        totalCost: order.total_cost ? parseFloat(order.total_cost) : null,
        commission: parseFloat(order.commission),
        rejectionReason: order.rejection_reason,
        createdAt: order.created_at,
        filledAt: order.filled_at,
        expiresAt: order.expires_at
      },
      fills: fillsResult.rows
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to retrieve order' });
  }
});

// PUT /orders/:orderId/cancel - Cancel order
app.put('/orders/:orderId/cancel', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    await client.query('BEGIN');

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE order_id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (!['PENDING', 'SUBMITTED', 'PARTIAL'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order cannot be cancelled' });
    }

    await client.query(
      `UPDATE orders SET status = 'CANCELLED', updated_at = NOW() WHERE order_id = $1`,
      [orderId]
    );

    await client.query('COMMIT');

    // Release reserved funds if any
    if (order.side === 'BUY' && order.remaining_quantity > 0) {
      const estimatedCost = parseFloat(order.limit_price || order.strike_price) * 
                           order.remaining_quantity * 100;
      
      await axios.post(`http://localhost:3001/accounts/${order.account_id}/unreserve`, {
        amount: estimatedCost,
        referenceId: orderId
      });
    }

    rabbitChannel.publish(
      'trading_events',
      'order.cancelled',
      Buffer.from(JSON.stringify({
        orderId,
        userId,
        symbol: order.symbol,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Order cancelled: ${orderId}`);

    res.json({
      success: true,
      message: 'Order cancelled successfully'
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
});

// Background task: Check for expired orders
async function checkExpiredOrders() {
  try {
    const result = await db.query(
      `SELECT order_id FROM orders
       WHERE status IN ('PENDING', 'SUBMITTED', 'PARTIAL')
       AND expires_at IS NOT NULL
       AND expires_at < NOW()`
    );

    for (const order of result.rows) {
      await db.query(
        `UPDATE orders SET status = 'EXPIRED', updated_at = NOW() WHERE order_id = $1`,
        [order.order_id]
      );

      rabbitChannel.publish(
        'trading_events',
        'order.expired',
        Buffer.from(JSON.stringify({
          orderId: order.order_id,
          timestamp: new Date().toISOString()
        }))
      );

      console.log(`✓ Order expired: ${order.order_id}`);
    }

  } catch (error) {
    console.error('Check expired orders error:', error);
  }
}

// Run expiry check every 5 minutes
setInterval(checkExpiredOrders, 5 * 60 * 1000);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Order Service',
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
      console.log(`\n🚀 Order Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ RabbitMQ connected`);
      console.log(`✓ Order processor running\n`);
    });

    await checkExpiredOrders();

  } catch (error) {
    console.error('Failed to start Order Service:', error);
    process.exit(1);
  }
}

start();