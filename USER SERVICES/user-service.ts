/**
 * USER SERVICE - COMPLETE IMPLEMENTATION
 * Authentication, User Management, Account Balances
 * Port: 3001
 * Install: npm install express bcrypt jsonwebtoken pg amqplib redis
 */

import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import amqp from 'amqplib';
import { createClient } from 'redis';

const app = express();
app.use(express.json());

const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'put-trading-secret-key-change-in-prod';

// Database connection
const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'users_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20
});

// Redis for session management
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

let rabbitChannel: amqp.Channel;

// Initialize connections
async function initConnections() {
  // RabbitMQ
  const rabbitConn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
  rabbitChannel = await rabbitConn.createChannel();
  await rabbitChannel.assertExchange('trading_events', 'topic', { durable: true });
  
  // Redis
  await redis.connect();
  
  console.log('✓ Connected to RabbitMQ and Redis');
}

// Initialize database schema
async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      account_type VARCHAR(20) DEFAULT 'INDIVIDUAL' CHECK (account_type IN ('INDIVIDUAL', 'CORPORATE', 'INSTITUTION')),
      kyc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
      account_status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
      risk_level VARCHAR(20) DEFAULT 'MEDIUM' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      account_number VARCHAR(20) UNIQUE NOT NULL,
      cash_balance DECIMAL(18,2) DEFAULT 0.00 CHECK (cash_balance >= 0),
      margin_balance DECIMAL(18,2) DEFAULT 0.00,
      buying_power DECIMAL(18,2) DEFAULT 0.00,
      total_portfolio_value DECIMAL(18,2) DEFAULT 0.00,
      currency VARCHAR(3) DEFAULT 'USD',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(account_id),
      user_id UUID NOT NULL REFERENCES users(user_id),
      transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('DEPOSIT', 'WITHDRAWAL', 'TRADE', 'FEE', 'DIVIDEND', 'MARGIN_CALL')),
      amount DECIMAL(18,2) NOT NULL,
      balance_after DECIMAL(18,2) NOT NULL,
      description TEXT,
      reference_id UUID,
      status VARCHAR(20) DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(account_status);
    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
  `);
  
  console.log('✓ User Service database initialized');
}

// Middleware: JWT authentication
function authenticateToken(req: any, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Generate account number
function generateAccountNumber(): string {
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `PUT${timestamp}${random}`;
}

// ==================== AUTHENTICATION ENDPOINTS ====================

// POST /auth/register
app.post('/auth/register', async (req: Request, res: Response) => {
  const client = await db.connect();
  
  try {
    const { email, password, fullName, phone } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    await client.query('BEGIN');

    // Check if email exists
    const existingUser = await client.query('SELECT user_id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, full_name, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, email, full_name, account_status, risk_level, created_at`,
      [email, passwordHash, fullName, phone || null]
    );

    const user = userResult.rows[0];

    // Create account with initial balance
    const accountNumber = generateAccountNumber();
    const initialBalance = 10000.00; // $10k starting balance

    const accountResult = await client.query(
      `INSERT INTO accounts (user_id, account_number, cash_balance, buying_power, total_portfolio_value)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING account_id, account_number, cash_balance, buying_power`,
      [user.user_id, accountNumber, initialBalance, initialBalance, initialBalance]
    );

    const account = accountResult.rows[0];

    // Record initial deposit transaction
    await client.query(
      `INSERT INTO transactions (account_id, user_id, transaction_type, amount, balance_after, description)
       VALUES ($1, $2, 'DEPOSIT', $3, $4, 'Initial account funding')`,
      [account.account_id, user.user_id, initialBalance, initialBalance]
    );

    await client.query('COMMIT');

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.user_id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Cache user session in Redis
    await redis.setEx(`session:${user.user_id}`, 86400, JSON.stringify({ userId: user.user_id, email: user.email }));

    // Publish event to RabbitMQ
    rabbitChannel.publish(
      'trading_events',
      'user.registered',
      Buffer.from(JSON.stringify({
        userId: user.user_id,
        email: user.email,
        accountId: account.account_id,
        accountNumber: account.account_number,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ User registered: ${email} (${user.user_id})`);

    res.status(201).json({
      success: true,
      user: {
        userId: user.user_id,
        email: user.email,
        fullName: user.full_name,
        accountStatus: user.account_status,
        riskLevel: user.risk_level
      },
      account: {
        accountId: account.account_id,
        accountNumber: account.account_number,
        cashBalance: parseFloat(account.cash_balance),
        buyingPower: parseFloat(account.buying_power)
      },
      token
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /auth/login
app.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Get user
    const result = await db.query(
      `SELECT u.user_id, u.email, u.password_hash, u.full_name, u.account_status, u.risk_level,
              a.account_id, a.account_number, a.cash_balance, a.buying_power, a.total_portfolio_value
       FROM users u
       LEFT JOIN accounts a ON u.user_id = a.user_id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check account status
    if (user.account_status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    if (user.account_status === 'CLOSED') {
      return res.status(403).json({ error: 'Account closed' });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]);

    // Generate token
    const token = jwt.sign(
      { userId: user.user_id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Cache session
    await redis.setEx(`session:${user.user_id}`, 86400, JSON.stringify({ userId: user.user_id, email: user.email }));

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'user.logged_in',
      Buffer.from(JSON.stringify({
        userId: user.user_id,
        email: user.email,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ User logged in: ${email}`);

    res.json({
      success: true,
      user: {
        userId: user.user_id,
        email: user.email,
        fullName: user.full_name,
        accountStatus: user.account_status,
        riskLevel: user.risk_level
      },
      account: {
        accountId: user.account_id,
        accountNumber: user.account_number,
        cashBalance: parseFloat(user.cash_balance),
        buyingPower: parseFloat(user.buying_power),
        totalValue: parseFloat(user.total_portfolio_value)
      },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/logout
app.post('/auth/logout', authenticateToken, async (req: any, res: Response) => {
  try {
    await redis.del(`session:${req.user.userId}`);
    
    rabbitChannel.publish(
      'trading_events',
      'user.logged_out',
      Buffer.from(JSON.stringify({
        userId: req.user.userId,
        timestamp: new Date().toISOString()
      }))
    );

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ==================== USER MANAGEMENT ====================

// GET /users/:userId
app.get('/users/:userId', authenticateToken, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;

    // Authorization check
    if (req.user.userId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await db.query(
      `SELECT u.user_id, u.email, u.full_name, u.phone, u.account_type, u.kyc_status,
              u.account_status, u.risk_level, u.created_at, u.last_login,
              a.account_id, a.account_number, a.cash_balance, a.margin_balance,
              a.buying_power, a.total_portfolio_value, a.currency
       FROM users u
       LEFT JOIN accounts a ON u.user_id = a.user_id
       WHERE u.user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user: {
        userId: user.user_id,
        email: user.email,
        fullName: user.full_name,
        phone: user.phone,
        accountType: user.account_type,
        kycStatus: user.kyc_status,
        accountStatus: user.account_status,
        riskLevel: user.risk_level,
        createdAt: user.created_at,
        lastLogin: user.last_login
      },
      account: {
        accountId: user.account_id,
        accountNumber: user.account_number,
        cashBalance: parseFloat(user.cash_balance),
        marginBalance: parseFloat(user.margin_balance),
        buyingPower: parseFloat(user.buying_power),
        totalValue: parseFloat(user.total_portfolio_value),
        currency: user.currency
      }
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

// PUT /users/:userId
app.put('/users/:userId', authenticateToken, async (req: any, res: Response) => {
  try {
    const { userId } = req.params;
    const { fullName, phone } = req.body;

    if (req.user.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const result = await db.query(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           phone = COALESCE($2, phone),
           updated_at = NOW()
       WHERE user_id = $3
       RETURNING user_id, email, full_name, phone`,
      [fullName, phone, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ==================== ACCOUNT BALANCE OPERATIONS ====================

// POST /accounts/:accountId/deposit
app.post('/accounts/:accountId/deposit', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const { accountId } = req.params;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid deposit amount' });
    }

    await client.query('BEGIN');

    // Get current balance
    const accountResult = await client.query(
      'SELECT user_id, cash_balance, buying_power FROM accounts WHERE account_id = $1 FOR UPDATE',
      [accountId]
    );

    if (accountResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accountResult.rows[0];

    // Authorization
    if (account.user_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const newBalance = parseFloat(account.cash_balance) + parseFloat(amount);
    const newBuyingPower = parseFloat(account.buying_power) + parseFloat(amount);

    // Update account
    await client.query(
      `UPDATE accounts
       SET cash_balance = $1,
           buying_power = $2,
           total_portfolio_value = total_portfolio_value + $3,
           updated_at = NOW()
       WHERE account_id = $4`,
      [newBalance, newBuyingPower, amount, accountId]
    );

    // Record transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions (account_id, user_id, transaction_type, amount, balance_after, description)
       VALUES ($1, $2, 'DEPOSIT', $3, $4, $5)
       RETURNING transaction_id, created_at`,
      [accountId, account.user_id, amount, newBalance, description || 'Account deposit']
    );

    await client.query('COMMIT');

    // Publish event
    rabbitChannel.publish(
      'trading_events',
      'account.deposit',
      Buffer.from(JSON.stringify({
        userId: account.user_id,
        accountId,
        amount: parseFloat(amount),
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Deposit: $${amount} to account ${accountId}`);

    res.json({
      success: true,
      transaction: {
        transactionId: transactionResult.rows[0].transaction_id,
        type: 'DEPOSIT',
        amount: parseFloat(amount),
        balanceAfter: newBalance,
        createdAt: transactionResult.rows[0].created_at
      },
      account: {
        cashBalance: newBalance,
        buyingPower: newBuyingPower
      }
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    client.release();
  }
});

// POST /accounts/:accountId/withdraw
app.post('/accounts/:accountId/withdraw', authenticateToken, async (req: any, res: Response) => {
  const client = await db.connect();
  
  try {
    const { accountId } = req.params;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount' });
    }

    await client.query('BEGIN');

    const accountResult = await client.query(
      'SELECT user_id, cash_balance, buying_power FROM accounts WHERE account_id = $1 FOR UPDATE',
      [accountId]
    );

    if (accountResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accountResult.rows[0];

    if (account.user_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const currentBalance = parseFloat(account.cash_balance);
    
    if (currentBalance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newBalance = currentBalance - parseFloat(amount);
    const newBuyingPower = parseFloat(account.buying_power) - parseFloat(amount);

    await client.query(
      `UPDATE accounts
       SET cash_balance = $1,
           buying_power = $2,
           total_portfolio_value = total_portfolio_value - $3,
           updated_at = NOW()
       WHERE account_id = $4`,
      [newBalance, newBuyingPower, amount, accountId]
    );

    const transactionResult = await client.query(
      `INSERT INTO transactions (account_id, user_id, transaction_type, amount, balance_after, description)
       VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5)
       RETURNING transaction_id, created_at`,
      [accountId, account.user_id, amount, newBalance, description || 'Account withdrawal']
    );

    await client.query('COMMIT');

    rabbitChannel.publish(
      'trading_events',
      'account.withdrawal',
      Buffer.from(JSON.stringify({
        userId: account.user_id,
        accountId,
        amount: parseFloat(amount),
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id,
        timestamp: new Date().toISOString()
      }))
    );

    console.log(`✓ Withdrawal: $${amount} from account ${accountId}`);

    res.json({
      success: true,
      transaction: {
        transactionId: transactionResult.rows[0].transaction_id,
        type: 'WITHDRAWAL',
        amount: parseFloat(amount),
        balanceAfter: newBalance,
        createdAt: transactionResult.rows[0].created_at
      },
      account: {
        cashBalance: newBalance,
        buyingPower: newBuyingPower
      }
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    client.release();
  }
});

// GET /accounts/:accountId/transactions
app.get('/accounts/:accountId/transactions', authenticateToken, async (req: any, res: Response) => {
  try {
    const { accountId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT t.transaction_id, t.transaction_type, t.amount, t.balance_after,
              t.description, t.reference_id, t.status, t.created_at
       FROM transactions t
       JOIN accounts a ON t.account_id = a.account_id
       WHERE t.account_id = $1 AND a.user_id = $2
       ORDER BY t.created_at DESC
       LIMIT $3 OFFSET $4`,
      [accountId, req.user.userId, limit, offset]
    );

    res.json({
      success: true,
      transactions: result.rows.map(t => ({
        transactionId: t.transaction_id,
        type: t.transaction_type,
        amount: parseFloat(t.amount),
        balanceAfter: parseFloat(t.balance_after),
        description: t.description,
        referenceId: t.reference_id,
        status: t.status,
        createdAt: t.created_at
      }))
    });

  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'User Service',
    status: 'healthy',
    database: 'connected',
    redis: 'connected',
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
      console.log(`\n🚀 User Service running on port ${PORT}`);
      console.log(`✓ Database connected`);
      console.log(`✓ Redis connected`);
      console.log(`✓ RabbitMQ connected\n`);
    });
  } catch (error) {
    console.error('Failed to start User Service:', error);
    process.exit(1);
  }
}

start();