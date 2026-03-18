import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'crypto';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/privacy_swap',
});

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

// Service URLs
const SERVICES = {
  proof: process.env.PROOF_SERVICE_URL || 'http://localhost:3001',
  merkle: process.env.MERKLE_SERVICE_URL || 'http://localhost:3002',
  monitor: process.env.MONITOR_SERVICE_URL || 'http://localhost:3003',
  webhook: process.env.WEBHOOK_SERVICE_URL || 'http://localhost:3004',
  swap: process.env.SWAP_SERVICE_URL || 'http://localhost:3005',
};

// Rate limiting configuration
const createRateLimiter = (windowMs: number, max: number) => {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: res.getHeader('Retry-After'),
      });
    },
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
  });
};

// Global rate limiter: 100 requests per minute
const globalLimiter = createRateLimiter(60 * 1000, 100);

// Proof generation rate limiter: 10 per minute (expensive operation)
const proofLimiter = createRateLimiter(60 * 1000, 10);

// API key authentication middleware
async function authenticateAPIKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    // Check if API key exists and is active
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const result = await pool.query(
      `SELECT * FROM api_keys WHERE key_hash = $1 AND active = true`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const keyData = result.rows[0];

    // Check rate limit for this API key
    const rateLimitKey = `ratelimit:${keyData.id}`;
    const requestCount = await redis.incr(rateLimitKey);
    
    if (requestCount === 1) {
      await redis.expire(rateLimitKey, 60);
    }

    if (requestCount > keyData.rate_limit_per_minute) {
      return res.status(429).json({ error: 'API key rate limit exceeded' });
    }

    // Update last used timestamp
    await pool.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [keyData.id]
    );

    // Attach user info to request
    req.user = {
      id: keyData.user_id,
      apiKeyId: keyData.id,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// JWT authentication middleware
function authenticateJWT(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'JWT token required' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid JWT token' });
  }
}

// Request logging middleware
async function logRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
  const requestId = randomBytes(16).toString('hex');
  req.requestId = requestId;

  const startTime = Date.now();

  // Log request
  const logEntry = {
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    timestamp: startTime,
  };

  await redis.set(`request:${requestId}`, JSON.stringify(logEntry), 'EX', 86400);

  // Log response
  res.on('finish', async () => {
    const duration = Date.now() - startTime;
    const responseLog = {
      ...logEntry,
      statusCode: res.statusCode,
      duration,
    };

    await pool.query(
      `INSERT INTO api_logs (
        request_id, method, path, user_id, status_code,
        duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [requestId, req.method, req.path, req.user?.id || null, res.statusCode, duration]
    );
  });

  next();
}

// Apply middleware
app.use(globalLimiter);
app.use(logRequest);

// Public endpoints (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'api-gateway' });
});

// Create API key
app.post('/api-keys', async (req, res) => {
  try {
    const { userId, rateLimitPerMinute = 60 } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Generate API key
    const apiKey = randomBytes(32).toString('hex');
    const keyHash = await bcrypt.hash(apiKey, 12);

    const result = await pool.query(
      `INSERT INTO api_keys (
        id, user_id, key_hash, rate_limit_per_minute, active, created_at
      ) VALUES ($1, $2, $3, $4, true, NOW())
      RETURNING id, user_id, rate_limit_per_minute, active, created_at`,
      [randomBytes(16).toString('hex'), userId, keyHash, rateLimitPerMinute]
    );

    res.json({
      ...result.rows[0],
      apiKey, // Only returned once
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login endpoint (generates JWT)
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Verify credentials with bcrypt
    const result = await pool.query(
      `SELECT id, username, password_hash FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Protected routes - require API key authentication
app.use('/api/proof', authenticateAPIKey, proofLimiter, createProxyMiddleware({
  target: SERVICES.proof,
  changeOrigin: true,
  pathRewrite: { '^/api/proof': '' },
}));

app.use('/api/merkle', authenticateAPIKey, createProxyMiddleware({
  target: SERVICES.merkle,
  changeOrigin: true,
  pathRewrite: { '^/api/merkle': '' },
}));

app.use('/api/monitor', authenticateAPIKey, createProxyMiddleware({
  target: SERVICES.monitor,
  changeOrigin: true,
  pathRewrite: { '^/api/monitor': '' },
}));

app.use('/api/webhook', authenticateAPIKey, createProxyMiddleware({
  target: SERVICES.webhook,
  changeOrigin: true,
  pathRewrite: { '^/api/webhook': '' },
}));

app.use('/api/swap', authenticateAPIKey, createProxyMiddleware({
  target: SERVICES.swap,
  changeOrigin: true,
  pathRewrite: { '^/api/swap': '' },
}));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: any;
      requestId?: string;
    }
  }
}
