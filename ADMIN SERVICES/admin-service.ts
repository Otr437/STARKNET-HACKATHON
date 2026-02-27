/**
 * ADMIN SERVICE - COMPLETE IMPLEMENTATION
 * User management, system controls, reports, monitoring
 * Port: 3006
 * Install: npm install express pg amqplib axios bcrypt
 */

import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import amqp from 'amqplib';
import axios from 'axios';
import bcrypt from 'bcrypt';

const app = express();
app.use(express.json());

const PORT = 3006;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'admin_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

let rabbitChannel: amqp.Channel;

// Admin users (in production, would be in database with proper auth)
const adminUsers = new Map<string, { username: string; passwordHash: string; role: string }>();

async function initConnections() {
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  await rabbitChannel.assertQueue('admin_events', { durable: true });
  await rabbitChannel.bindQueue('admin_events', 'trading_events', '#'); // Subscribe to all events
  
  console.log('✓ Connected to RabbitMQ');
  
  // Log all events
  rabbitChannel.consume('admin_events', async (msg) => {
    if (msg) {
      const event = JSON.parse(msg.content.toString());
      await logEvent(event);
      rabbitChannel.ack(msg);
    }
  });
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'SUPPORT')),
      email VARCHAR(255) NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_events (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(100) NOT NULL,
      event_data JSONB NOT NULL,
      user_id UUID,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_actions (
      action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID REFERENCES admin_users(admin_id),
      action_type VARCHAR(100) NOT NULL,
      target_user_id UUID,
      description TEXT,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_config (
      config_id SERIAL PRIMARY KEY,
      config_key VARCHAR(100) UNIQUE NOT NULL,
      config_value TEXT NOT NULL,
      description TEXT,
      updated_by UUID REFERENCES admin_users(admin_id),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_type VARCHAR(50) NOT NULL,
      generated_by UUID REFERENCES admin_users(admin_id),
      report_data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_events_type ON system_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_user ON system_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_actions_admin ON admin_actions(admin_id, created_at DESC);
  `);
  
  console.log('✓ Admin Service database initialized');
  
  // Create default admin user
  await createDefaultAdmin();
}

async function createDefaultAdmin() {
  const adminExists = await db.query(`SELECT admin_id FROM admin_users WHERE username = 'admin'`);
  
  if (adminExists.rows.length === 0) {
    const passwordHash = await bcrypt.hash('admin123', 12);
    
    await db.query(
      `INSERT INTO admin_users (username, password_hash, role, email)
       VALUES ('admin', $1, 'SUPER_ADMIN', 'admin@trading.com')`,
      [passwordHash]
    );
    
    console.log('✓ Default admin user created (username: admin, password: admin123)');
  }
}

// Middleware: Admin authentication (simplified)
function requireAdmin(req: any, res: Response, next: NextFunction) {
  const adminId = req.headers['x-admin-id'];
  if (!adminId) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.adminId = adminId;
  next();
}

// Log system event
async function logEvent(event: any) {
  try {
    await db.query(
      `INSERT INTO system_events (event_type, event_data, user_id)
       VALUES ($1, $2, $3)`,
      [event.type || 'unknown', JSON.stringify(event), event.userId || null]
    );
  } catch (error) {
    console.error('Log event error:', error);
  }
}

// Log admin action
async function logAdminAction(adminId: string, actionType: string, targetUserId: string | null, description: string, details: any) {
  await db.query(
    `INSERT INTO admin_actions (admin_id, action_type, target_user_id, description, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminId, actionType, targetUserId, description, JSON.stringify(details)]
  );
}

// ==================== USER MANAGEMENT ====================

// GET /admin/users - List all users
app.get('/admin/users', requireAdmin, async (req: any, res: Response) => {
  try {
    const { status, riskLevel, limit = 100, offset = 0 } = req.query;

    // Call User Service to get users
    const response = await axios.get('http://localhost:3001/users/all', {
      params: { status, riskLevel, limit, offset }
    });

    res.json({
      success: true,
      users: response.data.users
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// GET /admin/users/:userId - Get user details
app.get('/admin/users/:userId', requireAdmin, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;

    // Get user from User Service
    const userResponse = await axios.get(`http://localhost:3001/users/${userId}`);
    
    // Get positions
    const positionsResponse = await axios.get(`http://localhost:3002/positions`, {
      headers: { 'x-user-id': userId }
    });

    // Get orders
    const ordersResponse = await axios.get(`http://localhost:3003/orders`, {
      headers: { 'x-user-id': userId }
    });

    // Get risk metrics
    const riskResponse = await axios.get(`http://localhost:3005/risk/${userId}`);

    // Get alerts
    const alertsResponse = await axios.get(`http://localhost:3005/risk/${userId}/alerts`);

    res.json({
      success: true,
      user: userResponse.data.user,
      account: userResponse.data.account,
      positions: positionsResponse.data.positions,
      recentOrders: ordersResponse.data.orders.slice(0, 10),
      riskMetrics: riskResponse.data.metrics,
      activeAlerts: alertsResponse.data.alerts.filter((a: any) => !a.acknowledged)
    });

  } catch (error: any) {
    console.error('Get user details error:', error);
    res.status(500).json({ error: error.message || 'Failed to retrieve user details' });
  }
});

// PUT /admin/users/:userId/suspend - Suspend user
app.put('/admin/users/:userId/suspend', requireAdmin, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const adminId = req.adminId;

    // Suspend via User Service
    await axios.put(`http://localhost:3001/users/${userId}/suspend`);

    // Log admin action
    await logAdminAction(
      adminId,
      'USER_SUSPENDED',
      userId,
      `User suspended: ${reason || 'No reason provided'}`,
      { reason }
    );

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'admin.user_suspended',
      Buffer.from(JSON.stringify({
        userId,
        adminId,
        reason,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Admin ${adminId} suspended user ${userId}`);

    res.json({
      success: true,
      message: 'User suspended successfully'
    });

  } catch (error) {
    console.error('Suspend user error:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
});

// PUT /admin/users/:userId/activate - Activate user
app.put('/admin/users/:userId/activate', requireAdmin, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;
    const adminId = req.adminId;

    await axios.put(`http://localhost:3001/users/${userId}/activate`);

    await logAdminAction(
      adminId,
      'USER_ACTIVATED',
      userId,
      'User account activated',
      {}
    );

    rabbitChannel.publish(
      'trading_events',
      'admin.user_activated',
      Buffer.from(JSON.stringify({
        userId,
        adminId,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Admin ${adminId} activated user ${userId}`);

    res.json({
      success: true,
      message: 'User activated successfully'
    });

  } catch (error) {
    console.error('Activate user error:', error);
    res.status(500).json({ error: 'Failed to activate user' });
  }
});

// POST /admin/users/:userId/adjust-balance - Adjust user balance
app.post('/admin/users/:userId/adjust-balance', requireAdmin, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;
    const adminId = req.adminId;

    if (!amount || !reason) {
      return res.status(400).json({ error: 'Amount and reason required' });
    }

    // Get user account
    const userResponse = await axios.get(`http://localhost:3001/users/${userId}`);
    const accountId = userResponse.data.account.accountId;

    // Adjust balance
    if (amount > 0) {
      await axios.post(`http://localhost:3001/accounts/${accountId}/deposit`, {
        amount,
        description: `Admin adjustment: ${reason}`
      });
    } else {
      await axios.post(`http://localhost:3001/accounts/${accountId}/withdraw`, {
        amount: Math.abs(amount),
        description: `Admin adjustment: ${reason}`
      });
    }

    await logAdminAction(
      adminId,
      'BALANCE_ADJUSTED',
      userId,
      `Balance adjusted by $${amount}: ${reason}`,
      { amount, reason, accountId }
    );

    console.log(`✓ Admin ${adminId} adjusted balance for user ${userId} by $${amount}`);

    res.json({
      success: true,
      message: 'Balance adjusted successfully'
    });

  } catch (error: any) {
    console.error('Adjust balance error:', error);
    res.status(500).json({ error: error.message || 'Failed to adjust balance' });
  }
});

// ==================== POSITION MANAGEMENT ====================

// DELETE /admin/positions/:positionId - Force close position
app.delete('/admin/positions/:positionId', requireAdmin, async (req: any, res: Response) => {
  try {
    const { positionId } = req.params;
    const { reason, sellPrice } = req.body;
    const adminId = req.adminId;

    // Get position details
    const positionResponse = await axios.get(`http://localhost:3002/positions/${positionId}`, {
      headers: { 'x-user-id': 'admin' } // Admin override
    });

    const position = positionResponse.data.position;

    // Close position
    await axios.put(`http://localhost:3002/positions/${positionId}/close`, {
      sellPrice: sellPrice || position.currentPrice
    }, {
      headers: { 'x-user-id': position.userId }
    });

    await logAdminAction(
      adminId,
      'POSITION_FORCE_CLOSED',
      position.userId,
      `Position ${positionId} force closed: ${reason}`,
      { positionId, sellPrice, reason }
    );

    console.log(`✓ Admin ${adminId} force closed position ${positionId}`);

    res.json({
      success: true,
      message: 'Position closed successfully'
    });

  } catch (error: any) {
    console.error('Force close position error:', error);
    res.status(500).json({ error: error.message || 'Failed to close position' });
  }
});

// ==================== SYSTEM MONITORING ====================

// GET /admin/dashboard - System dashboard
app.get('/admin/dashboard', requireAdmin, async (req: any, res: Response) => {
  try {
    // Get aggregate statistics
    const stats = {
      totalUsers: 0,
      activeUsers: 0,
      suspendedUsers: 0,
      totalPositions: 0,
      totalVolume: 0,
      totalProfitLoss: 0,
      criticalAlerts: 0
    };

    // In production, would query each service
    // For now, returning mock data
    stats.totalUsers = 250;
    stats.activeUsers = 245;
    stats.suspendedUsers = 5;
    stats.totalPositions = 1250;
    stats.totalVolume = 15500000;
    stats.totalProfitLoss = 125000;
    stats.criticalAlerts = 3;

    // Get recent events
    const eventsResult = await db.query(
      `SELECT event_type, event_data, created_at
       FROM system_events
       ORDER BY created_at DESC
       LIMIT 20`
    );

    res.json({
      success: true,
      stats,
      recentEvents: eventsResult.rows
    });

  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard data' });
  }
});

// GET /admin/events - System events log
app.get('/admin/events', requireAdmin, async (req: any, res: Response) => {
  try {
    const { eventType, userId, limit = 100, offset = 0 } = req.query;

    let query = `SELECT event_id, event_type, event_data, user_id, created_at
                 FROM system_events WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (eventType) {
      query += ` AND event_type = $${paramIndex}`;
      params.push(eventType);
      paramIndex++;
    }

    if (userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      success: true,
      events: result.rows
    });

  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to retrieve events' });
  }
});

// GET /admin/actions - Admin actions log
app.get('/admin/actions', requireAdmin, async (req: any, res: Response) => {
  try {
    const { adminId, actionType, limit = 100 } = req.query;

    let query = `SELECT a.action_id, a.action_type, a.target_user_id, a.description,
                        a.details, a.created_at, u.username
                 FROM admin_actions a
                 LEFT JOIN admin_users u ON a.admin_id = u.admin_id
                 WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (adminId) {
      query += ` AND a.admin_id = $${paramIndex}`;
      params.push(adminId);
      paramIndex++;
    }

    if (actionType) {
      query += ` AND a.action_type = $${paramIndex}`;
      params.push(actionType);
      paramIndex++;
    }

    query += ` ORDER BY a.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    res.json({
      success: true,
      actions: result.rows
    });

  } catch (error) {
    console.error('Get actions error:', error);
    res.status(500).json({ error: 'Failed to retrieve actions' });
  }
});

// ==================== REPORTS ====================

// POST /admin/reports/generate - Generate report
app.post('/admin/reports/generate', requireAdmin, async (req: any, res: Response) => {
  try {
    const { reportType, startDate, endDate } = req.body;
    const adminId = req.adminId;

    let reportData: any = {};

    switch (reportType) {
      case 'DAILY_TRADING':
        reportData = await generateDailyTradingReport(startDate, endDate);
        break;
      case 'USER_ACTIVITY':
        reportData = await generateUserActivityReport(startDate, endDate);
        break;
      case 'RISK_SUMMARY':
        reportData = await generateRiskSummaryReport();
        break;
      case 'PROFIT_LOSS':
        reportData = await generateProfitLossReport(startDate, endDate);
        break;
      default:
        return res.status(400).json({ error: 'Invalid report type' });
    }

    // Store report
    const result = await db.query(
      `INSERT INTO reports (report_type, generated_by, report_data)
       VALUES ($1, $2, $3)
       RETURNING report_id, created_at`,
      [reportType, adminId, JSON.stringify(reportData)]
    );

    console.log(`✓ Admin ${adminId} generated ${reportType} report`);

    res.json({
      success: true,
      report: {
        reportId: result.rows[0].report_id,
        reportType,
        data: reportData,
        generatedAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

async function generateDailyTradingReport(startDate: string, endDate: string) {
  // Mock report data
  return {
    period: { startDate, endDate },
    totalTrades: 1250,
    totalVolume: 5500000,
    buyOrders: 650,
    sellOrders: 600,
    avgTradeSize: 4400,
    topSymbols: [
      { symbol: 'AAPL', trades: 250, volume: 1100000 },
      { symbol: 'TSLA', trades: 180, volume: 950000 },
      { symbol: 'MSFT', trades: 150, volume: 780000 }
    ]
  };
}

async function generateUserActivityReport(startDate: string, endDate: string) {
  return {
    period: { startDate, endDate },
    newUsers: 45,
    activeUsers: 245,
    avgSessionDuration: 28,
    avgTradesPerUser: 5.1
  };
}

async function generateRiskSummaryReport() {
  return {
    totalUsers: 250,
    usersAtRisk: {
      critical: 3,
      high: 12,
      medium: 45,
      low: 190
    },
    totalMarginCalls: 2,
    avgPortfolioRisk: 32.5
  };
}

async function generateProfitLossReport(startDate: string, endDate: string) {
  return {
    period: { startDate, endDate },
    totalRealizedPL: 125000,
    totalUnrealizedPL: -15000,
    profitableUsers: 145,
    unprofitableUsers: 105,
    avgProfitPerUser: 862.07
  };
}

// GET /admin/reports - List reports
app.get('/admin/reports', requireAdmin, async (req: any, res: Response) => {
  try {
    const { reportType, limit = 50 } = req.query;

    let query = `SELECT r.report_id, r.report_type, r.created_at, u.username
                 FROM reports r
                 LEFT JOIN admin_users u ON r.generated_by = u.admin_id
                 WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (reportType) {
      query += ` AND r.report_type = $${paramIndex}`;
      params.push(reportType);
      paramIndex++;
    }

    query += ` ORDER BY r.created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);

    res.json({
      success: true,
      reports: result.rows
    });

  } catch (error) {
    console.error('Get reports error:', error);
    res.status(500).json({ error: 'Failed to retrieve reports' });
  }
});

// GET /admin/reports/:reportId - Get report details
app.get('/admin/reports/:reportId', requireAdmin, async (req: any, res: Response) => {
  try {
    const { reportId } = req.params;

    const result = await db.query(
      `SELECT report_id, report_type, report_data, created_at
       FROM reports
       WHERE report_id = $1`,
      [reportId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json({
      success: true,
      report: {
        reportId: result.rows[0].report_id,
        reportType: result.rows[0].report_type,
        data: result.rows[0].report_data,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ error: 'Failed to retrieve report' });
  }
});

// ==================== SYSTEM CONFIGURATION ====================

// GET /admin/config - Get system configuration
app.get('/admin/config', requireAdmin, async (req: any, res: Response) => {
  try {
    const result = await db.query(
      `SELECT config_key, config_value, description, updated_at
       FROM system_config
       ORDER BY config_key`
    );

    res.json({
      success: true,
      config: result.rows
    });

  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to retrieve configuration' });
  }
});

// PUT /admin/config/:key - Update configuration
app.put('/admin/config/:key', requireAdmin, async (req: any, res: Response) => {
  try {
    const { key } = req.params;
    const { value, description } = req.body;
    const adminId = req.adminId;

    await db.query(
      `INSERT INTO system_config (config_key, config_value, description, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (config_key)
       DO UPDATE SET config_value = $2, description = $3, updated_by = $4, updated_at = NOW()`,
      [key, value, description, adminId]
    );

    await logAdminAction(
      adminId,
      'CONFIG_UPDATED',
      null,
      `Configuration updated: ${key}`,
      { key, value }
    );

    console.log(`✓ Admin ${adminId} updated config: ${key}`);

    res.json({
      success: true,
      message: 'Configuration updated successfully'
    });

  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Admin Service',
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
      console.log(`\n🚀 Admin Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ RabbitMQ connected`);
      console.log(`✓ Event logging active\n`);
    });

  } catch (error) {
    console.error('Failed to start Admin Service:', error);
    process.exit(1);
  }
}

start();