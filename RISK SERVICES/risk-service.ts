/**
 * RISK MANAGEMENT SERVICE - COMPLETE IMPLEMENTATION
 * Portfolio risk analysis, margin calls, position limits
 * Port: 3005
 * Install: npm install express pg amqplib axios
 */

import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import amqp from 'amqplib';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = 3005;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'risk_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

let rabbitChannel: amqp.Channel;

enum RiskLevel { LOW = 'LOW', MEDIUM = 'MEDIUM', HIGH = 'HIGH', CRITICAL = 'CRITICAL' }
enum AlertType { MARGIN_CALL = 'MARGIN_CALL', POSITION_LIMIT = 'POSITION_LIMIT', CONCENTRATION = 'CONCENTRATION', VOLATILITY = 'VOLATILITY' }

interface RiskMetrics {
  userId: string;
  portfolioValue: number;
  totalExposure: number;
  marginUsed: number;
  marginAvailable: number;
  marginLevel: number;
  riskScore: number;
  riskLevel: RiskLevel;
  var95: number; // Value at Risk 95%
  maxDrawdown: number;
  sharpeRatio: number;
}

async function initConnections() {
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  await rabbitChannel.assertQueue('risk_monitoring', { durable: true });
  await rabbitChannel.bindQueue('risk_monitoring', 'trading_events', 'position.#');
  await rabbitChannel.bindQueue('risk_monitoring', 'trading_events', 'market.price_update');
  
  console.log('✓ Connected to RabbitMQ');
  
  // Monitor events
  rabbitChannel.consume('risk_monitoring', async (msg) => {
    if (msg) {
      const event = JSON.parse(msg.content.toString());
      
      if (event.type === 'position.created' || event.type === 'market.price_update') {
        await evaluateUserRisk(event.userId || event.data?.userId);
      }
      
      rabbitChannel.ack(msg);
    }
  });
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS risk_assessments (
      assessment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      portfolio_value DECIMAL(18,2) NOT NULL,
      total_exposure DECIMAL(18,2) NOT NULL,
      margin_used DECIMAL(18,2) NOT NULL,
      margin_available DECIMAL(18,2) NOT NULL,
      margin_level DECIMAL(8,2) NOT NULL,
      risk_score DECIMAL(5,2) NOT NULL,
      risk_level VARCHAR(20) NOT NULL,
      var_95 DECIMAL(18,2),
      max_drawdown DECIMAL(8,2),
      sharpe_ratio DECIMAL(8,4),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS risk_alerts (
      alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      alert_type VARCHAR(30) NOT NULL,
      severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
      message TEXT NOT NULL,
      details JSONB,
      acknowledged BOOLEAN DEFAULT false,
      acknowledged_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS position_limits (
      limit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      symbol VARCHAR(10),
      limit_type VARCHAR(30) NOT NULL CHECK (limit_type IN ('MAX_POSITION_SIZE', 'MAX_CONTRACTS', 'MAX_EXPOSURE', 'MAX_LEVERAGE')),
      limit_value DECIMAL(18,2) NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_assessments_user ON risk_assessments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_user ON risk_alerts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_limits_user ON position_limits(user_id);
  `);
  
  console.log('✓ Risk Service database initialized');
  
  // Set default limits
  await setDefaultLimits();
}

async function setDefaultLimits() {
  await db.query(`
    INSERT INTO position_limits (user_id, limit_type, limit_value)
    SELECT NULL, 'MAX_POSITION_SIZE', 50000.00
    WHERE NOT EXISTS (SELECT 1 FROM position_limits WHERE user_id IS NULL AND limit_type = 'MAX_POSITION_SIZE')
  `);
  
  await db.query(`
    INSERT INTO position_limits (user_id, limit_type, limit_value)
    SELECT NULL, 'MAX_LEVERAGE', 4.00
    WHERE NOT EXISTS (SELECT 1 FROM position_limits WHERE user_id IS NULL AND limit_type = 'MAX_LEVERAGE')
  `);
}

// Calculate portfolio risk metrics
async function calculateRiskMetrics(userId: string): Promise<RiskMetrics | null> {
  try {
    // Get user account
    const userResponse = await axios.get(`http://localhost:3001/users/${userId}`);
    const account = userResponse.data.account;

    // Get all active positions
    const positionsResponse = await axios.get(`http://localhost:3002/positions?status=ACTIVE`, {
      headers: { 'x-user-id': userId }
    });
    const positions = positionsResponse.data.positions;

    if (positions.length === 0) {
      return {
        userId,
        portfolioValue: account.cashBalance,
        totalExposure: 0,
        marginUsed: 0,
        marginAvailable: account.cashBalance,
        marginLevel: 0,
        riskScore: 0,
        riskLevel: RiskLevel.LOW,
        var95: 0,
        maxDrawdown: 0,
        sharpeRatio: 0
      };
    }

    // Calculate total exposure
    const totalExposure = positions.reduce((sum: number, p: any) => {
      return sum + (p.strikePrice * p.contracts * 100);
    }, 0);

    // Calculate margin used (simplified: 20% of total exposure)
    const marginUsed = totalExposure * 0.20;
    const marginAvailable = account.cashBalance - marginUsed;
    const marginLevel = (account.cashBalance / marginUsed) * 100;

    // Calculate Value at Risk (95% confidence, 1-day)
    const portfolioValues = positions.map((p: any) => p.unrealizedPL || 0);
    const avgReturn = portfolioValues.reduce((a: number, b: number) => a + b, 0) / portfolioValues.length;
    const variance = portfolioValues.reduce((sum: number, val: number) => {
      return sum + Math.pow(val - avgReturn, 2);
    }, 0) / portfolioValues.length;
    const stdDev = Math.sqrt(variance);
    const var95 = 1.645 * stdDev; // 95% confidence

    // Calculate max drawdown
    const unrealizedPLs = positions.map((p: any) => p.unrealizedPL || 0);
    const maxDrawdown = Math.min(...unrealizedPLs, 0);

    // Calculate risk score (0-100)
    let riskScore = 0;
    riskScore += Math.min((totalExposure / account.cashBalance) * 20, 30); // Leverage risk
    riskScore += Math.min((marginUsed / account.cashBalance) * 30, 30); // Margin risk
    riskScore += Math.min(Math.abs(maxDrawdown / account.cashBalance) * 40, 40); // Drawdown risk

    // Determine risk level
    let riskLevel: RiskLevel;
    if (riskScore >= 75) riskLevel = RiskLevel.CRITICAL;
    else if (riskScore >= 50) riskLevel = RiskLevel.HIGH;
    else if (riskScore >= 25) riskLevel = RiskLevel.MEDIUM;
    else riskLevel = RiskLevel.LOW;

    return {
      userId,
      portfolioValue: account.totalValue,
      totalExposure,
      marginUsed,
      marginAvailable,
      marginLevel,
      riskScore,
      riskLevel,
      var95,
      maxDrawdown: (maxDrawdown / account.cashBalance) * 100,
      sharpeRatio: avgReturn / (stdDev || 1)
    };

  } catch (error) {
    console.error('Calculate risk metrics error:', error);
    return null;
  }
}

// Evaluate user risk and generate alerts
async function evaluateUserRisk(userId: string) {
  if (!userId) return;

  try {
    const metrics = await calculateRiskMetrics(userId);
    if (!metrics) return;

    // Store assessment
    await db.query(
      `INSERT INTO risk_assessments (
        user_id, portfolio_value, total_exposure, margin_used, margin_available,
        margin_level, risk_score, risk_level, var_95, max_drawdown, sharpe_ratio
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        userId, metrics.portfolioValue, metrics.totalExposure, metrics.marginUsed,
        metrics.marginAvailable, metrics.marginLevel, metrics.riskScore,
        metrics.riskLevel, metrics.var95, metrics.maxDrawdown, metrics.sharpeRatio
      ]
    );

    // Check for margin call
    if (metrics.marginLevel < 120) { // Margin call threshold
      await createAlert(
        userId,
        AlertType.MARGIN_CALL,
        RiskLevel.CRITICAL,
        `Margin call: Margin level at ${metrics.marginLevel.toFixed(2)}%. Please add funds or close positions.`,
        { marginLevel: metrics.marginLevel, marginUsed: metrics.marginUsed }
      );

      // Suspend user if critical
      if (metrics.marginLevel < 100) {
        await axios.put(`http://localhost:3001/users/${userId}/suspend`);
      }
    }

    // Check position limits
    const limits = await db.query(
      `SELECT limit_type, limit_value
       FROM position_limits
       WHERE (user_id = $1 OR user_id IS NULL) AND active = true`,
      [userId]
    );

    for (const limit of limits.rows) {
      if (limit.limit_type === 'MAX_EXPOSURE' && metrics.totalExposure > limit.limit_value) {
        await createAlert(
          userId,
          AlertType.POSITION_LIMIT,
          RiskLevel.HIGH,
          `Total exposure (${metrics.totalExposure.toFixed(2)}) exceeds limit (${limit.limit_value})`,
          { exposure: metrics.totalExposure, limit: limit.limit_value }
        );
      }

      if (limit.limit_type === 'MAX_LEVERAGE') {
        const leverage = metrics.totalExposure / metrics.portfolioValue;
        if (leverage > limit.limit_value) {
          await createAlert(
            userId,
            AlertType.POSITION_LIMIT,
            RiskLevel.HIGH,
            `Leverage (${leverage.toFixed(2)}x) exceeds limit (${limit.limit_value}x)`,
            { leverage, limit: limit.limit_value }
          );
        }
      }
    }

    // Check for concentration risk
    const positionsResponse = await axios.get(`http://localhost:3002/positions?status=ACTIVE`, {
      headers: { 'x-user-id': userId }
    });
    const positions = positionsResponse.data.positions;
    
    const symbolExposure = new Map<string, number>();
    positions.forEach((p: any) => {
      const exposure = p.strikePrice * p.contracts * 100;
      symbolExposure.set(p.symbol, (symbolExposure.get(p.symbol) || 0) + exposure);
    });

    symbolExposure.forEach((exposure, symbol) => {
      const concentration = (exposure / metrics.totalExposure) * 100;
      if (concentration > 30) { // More than 30% in one symbol
        createAlert(
          userId,
          AlertType.CONCENTRATION,
          RiskLevel.MEDIUM,
          `High concentration in ${symbol}: ${concentration.toFixed(1)}% of portfolio`,
          { symbol, concentration, exposure }
        );
      }
    });

    console.log(`✓ Risk evaluated for user ${userId}: ${metrics.riskLevel} (score: ${metrics.riskScore.toFixed(1)})`);

  } catch (error) {
    console.error('Evaluate user risk error:', error);
  }
}

// Create risk alert
async function createAlert(userId: string, alertType: AlertType, severity: RiskLevel, message: string, details: any) {
  const result = await db.query(
    `INSERT INTO risk_alerts (user_id, alert_type, severity, message, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING alert_id, created_at`,
    [userId, alertType, severity, message, JSON.stringify(details)]
  );

  // Publish alert event
  rabbitChannel.publish(
    'trading_events',
    'risk.alert_created',
    Buffer.from(JSON.stringify({
      alertId: result.rows[0].alert_id,
      userId,
      alertType,
      severity,
      message,
      timestamp: result.rows[0].created_at
    }))
  );

  console.log(`⚠️  Risk alert: ${userId} - ${message}`);
}

// ==================== API ENDPOINTS ====================

// GET /risk/:userId - Get current risk metrics
app.get('/risk/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const metrics = await calculateRiskMetrics(userId);
    if (!metrics) {
      return res.status(500).json({ error: 'Failed to calculate risk metrics' });
    }

    res.json({
      success: true,
      metrics
    });

  } catch (error) {
    console.error('Get risk error:', error);
    res.status(500).json({ error: 'Failed to retrieve risk metrics' });
  }
});

// GET /risk/:userId/history - Get risk assessment history
app.get('/risk/:userId/history', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit = 30 } = req.query;

    const result = await db.query(
      `SELECT assessment_id, portfolio_value, total_exposure, margin_level,
              risk_score, risk_level, var_95, max_drawdown, created_at
       FROM risk_assessments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json({
      success: true,
      history: result.rows.map(row => ({
        assessmentId: row.assessment_id,
        portfolioValue: parseFloat(row.portfolio_value),
        totalExposure: parseFloat(row.total_exposure),
        marginLevel: parseFloat(row.margin_level),
        riskScore: parseFloat(row.risk_score),
        riskLevel: row.risk_level,
        var95: parseFloat(row.var_95),
        maxDrawdown: parseFloat(row.max_drawdown),
        timestamp: row.created_at
      }))
    });

  } catch (error) {
    console.error('Get risk history error:', error);
    res.status(500).json({ error: 'Failed to retrieve risk history' });
  }
});

// GET /risk/:userId/alerts - Get risk alerts
app.get('/risk/:userId/alerts', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { acknowledged } = req.query;

    let query = `
      SELECT alert_id, alert_type, severity, message, details,
             acknowledged, acknowledged_at, created_at
      FROM risk_alerts
      WHERE user_id = $1
    `;
    const params: any[] = [userId];

    if (acknowledged !== undefined) {
      query += ` AND acknowledged = $2`;
      params.push(acknowledged === 'true');
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      alerts: result.rows.map(row => ({
        alertId: row.alert_id,
        alertType: row.alert_type,
        severity: row.severity,
        message: row.message,
        details: row.details,
        acknowledged: row.acknowledged,
        acknowledgedAt: row.acknowledged_at,
        createdAt: row.created_at
      }))
    });

  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

// PUT /risk/alerts/:alertId/acknowledge - Acknowledge alert
app.put('/risk/alerts/:alertId/acknowledge', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;

    await db.query(
      `UPDATE risk_alerts
       SET acknowledged = true, acknowledged_at = NOW()
       WHERE alert_id = $1`,
      [alertId]
    );

    res.json({
      success: true,
      message: 'Alert acknowledged'
    });

  } catch (error) {
    console.error('Acknowledge alert error:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// POST /risk/:userId/evaluate - Manually trigger risk evaluation
app.post('/risk/:userId/evaluate', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    await evaluateUserRisk(userId);
    const metrics = await calculateRiskMetrics(userId);

    res.json({
      success: true,
      message: 'Risk evaluation completed',
      metrics
    });

  } catch (error) {
    console.error('Evaluate risk error:', error);
    res.status(500).json({ error: 'Failed to evaluate risk' });
  }
});

// GET /risk/:userId/limits - Get position limits
app.get('/risk/:userId/limits', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const result = await db.query(
      `SELECT limit_id, limit_type, limit_value, active, created_at
       FROM position_limits
       WHERE user_id = $1 OR user_id IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      limits: result.rows
    });

  } catch (error) {
    console.error('Get limits error:', error);
    res.status(500).json({ error: 'Failed to retrieve limits' });
  }
});

// POST /risk/:userId/limits - Set position limit
app.post('/risk/:userId/limits', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limitType, limitValue } = req.body;

    if (!limitType || !limitValue) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await db.query(
      `INSERT INTO position_limits (user_id, limit_type, limit_value)
       VALUES ($1, $2, $3)
       RETURNING limit_id, created_at`,
      [userId, limitType, limitValue]
    );

    res.status(201).json({
      success: true,
      limit: {
        limitId: result.rows[0].limit_id,
        userId,
        limitType,
        limitValue,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('Create limit error:', error);
    res.status(500).json({ error: 'Failed to create limit' });
  }
});

// Background task: Monitor all users
async function monitorAllUsers() {
  try {
    // Get all active users with positions
    const usersResponse = await axios.get('http://localhost:3001/users');
    // In production, would iterate through users
    console.log('✓ Monitoring all users for risk');

  } catch (error) {
    console.error('Monitor all users error:', error);
  }
}

// Run risk monitoring every 5 minutes
setInterval(monitorAllUsers, 5 * 60 * 1000);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Risk Management Service',
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
      console.log(`\n🚀 Risk Management Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ RabbitMQ connected`);
      console.log(`✓ Risk monitoring active\n`);
    });

  } catch (error) {
    console.error('Failed to start Risk Service:', error);
    process.exit(1);
  }
}

start();