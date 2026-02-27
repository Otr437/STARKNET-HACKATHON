/**
 * API GATEWAY - COMPLETE IMPLEMENTATION
 * Routes requests, authentication, rate limiting, load balancing
 * Port: 3000
 * Install: npm install express express-rate-limit http-proxy-middleware jsonwebtoken cors helmet
 */

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const PORT = 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'put-trading-secret-key-change-in-prod';

// Service registry
const SERVICES = {
  USER: process.env.USER_SERVICE_URL || 'http://localhost:3001',
  POSITION: process.env.POSITION_SERVICE_URL || 'http://localhost:3002',
  ORDER: process.env.ORDER_SERVICE_URL || 'http://localhost:3003',
  MARKET: process.env.MARKET_SERVICE_URL || 'http://localhost:3004',
  RISK: process.env.RISK_SERVICE_URL || 'http://localhost:3005',
  ADMIN: process.env.ADMIN_SERVICE_URL || 'http://localhost:3006',
  AI: process.env.AI_SERVICE_URL || 'http://localhost:3007'
};

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 login attempts per 15 minutes
  message: 'Too many login attempts, please try again later',
  skipSuccessfulRequests: true
});

const tradingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 trades per minute
  message: 'Trading rate limit exceeded'
});

// JWT Authentication Middleware
function authenticateToken(req: any, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    req.headers['x-user-id'] = user.userId;
    next();
  });
}

// Admin authentication middleware
function requireAdmin(req: any, res: Response, next: NextFunction) {
  const adminToken = req.headers['x-admin-token'];
  
  if (!adminToken) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  // In production, verify admin token properly
  try {
    const decoded = jwt.verify(adminToken, JWT_SECRET) as any;
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.adminId = decoded.adminId;
    req.headers['x-admin-id'] = decoded.adminId;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'API Gateway',
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: SERVICES
  });
});

// Service health aggregation
app.get('/health/services', async (req: Request, res: Response) => {
  const healthChecks = await Promise.allSettled([
    fetch(`${SERVICES.USER}/health`),
    fetch(`${SERVICES.POSITION}/health`),
    fetch(`${SERVICES.ORDER}/health`),
    fetch(`${SERVICES.MARKET}/health`),
    fetch(`${SERVICES.RISK}/health`),
    fetch(`${SERVICES.ADMIN}/health`),
    fetch(`${SERVICES.AI}/health`)
  ]);

  const services = ['user', 'position', 'order', 'market', 'risk', 'admin', 'ai'];
  const statuses: any = {};

  healthChecks.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      statuses[services[index]] = 'healthy';
    } else {
      statuses[services[index]] = 'unhealthy';
    }
  });

  res.json({
    overall: Object.values(statuses).every(s => s === 'healthy') ? 'healthy' : 'degraded',
    services: statuses
  });
});

// ==================== PUBLIC ROUTES (No Auth) ====================

// Authentication routes - no rate limit on register, limited on login
app.use('/api/auth/register', createProxyMiddleware({
  target: SERVICES.USER,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' }
}));

app.use('/api/auth/login', authLimiter, createProxyMiddleware({
  target: SERVICES.USER,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' }
}));

// Market data (public)
app.use('/api/market', generalLimiter, createProxyMiddleware({
  target: SERVICES.MARKET,
  changeOrigin: true,
  pathRewrite: { '^/api/market': '/market' }
}));

// ==================== AUTHENTICATED USER ROUTES ====================

// User/Account routes
app.use('/api/users', authenticateToken, generalLimiter, createProxyMiddleware({
  target: SERVICES.USER,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '/users' }
}));

app.use('/api/accounts', authenticateToken, generalLimiter, createProxyMiddleware({
  target: SERVICES.USER,
  changeOrigin: true,
  pathRewrite: { '^/api/accounts': '/accounts' }
}));

// Position routes
app.use('/api/positions', authenticateToken, tradingLimiter, createProxyMiddleware({
  target: SERVICES.POSITION,
  changeOrigin: true,
  pathRewrite: { '^/api/positions': '/positions' },
  onProxyReq: (proxyReq, req: any) => {
    // Add user context to request
    proxyReq.setHeader('x-user-id', req.user.userId);
  }
}));

// Order routes
app.use('/api/orders', authenticateToken, tradingLimiter, createProxyMiddleware({
  target: SERVICES.ORDER,
  changeOrigin: true,
  pathRewrite: { '^/api/orders': '/orders' },
  onProxyReq: (proxyReq, req: any) => {
    proxyReq.setHeader('x-user-id', req.user.userId);
  }
}));

// Risk routes
app.use('/api/risk', authenticateToken, generalLimiter, createProxyMiddleware({
  target: SERVICES.RISK,
  changeOrigin: true,
  pathRewrite: { '^/api/risk': '/risk' }
}));

// AI Analysis routes
app.use('/api/ai', authenticateToken, generalLimiter, createProxyMiddleware({
  target: SERVICES.AI,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '' },
  onProxyReq: (proxyReq, req: any) => {
    proxyReq.setHeader('x-user-id', req.user.userId);
  }
}));

// ==================== ADMIN ROUTES ====================

app.use('/api/admin', requireAdmin, generalLimiter, createProxyMiddleware({
  target: SERVICES.ADMIN,
  changeOrigin: true,
  pathRewrite: { '^/api/admin': '/admin' },
  onProxyReq: (proxyReq, req: any) => {
    proxyReq.setHeader('x-admin-id', req.adminId);
  }
}));

// ==================== WEBSOCKET ROUTES ====================

// Market data WebSocket proxy
app.use('/ws/market', createProxyMiddleware({
  target: 'ws://localhost:8080',
  ws: true,
  changeOrigin: true
}));

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Gateway error:', err);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString(),
    path: req.path
  });
});

// ==================== CUSTOM ENDPOINTS ====================

// Aggregated portfolio view
app.get('/api/portfolio', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.user.userId;

    // Fetch from multiple services in parallel
    const [userResponse, positionsResponse, riskResponse] = await Promise.all([
      fetch(`${SERVICES.USER}/users/${userId}`, {
        headers: { 'x-user-id': userId }
      }),
      fetch(`${SERVICES.POSITION}/positions`, {
        headers: { 'x-user-id': userId }
      }),
      fetch(`${SERVICES.RISK}/risk/${userId}`)
    ]);

    const [userData, positionsData, riskData] = await Promise.all([
      userResponse.json(),
      positionsResponse.json(),
      riskResponse.json()
    ]);

    res.json({
      success: true,
      portfolio: {
        user: userData.user,
        account: userData.account,
        positions: positionsData.positions,
        riskMetrics: riskData.metrics
      }
    });

  } catch (error: any) {
    console.error('Portfolio aggregation error:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio data' });
  }
});

// Trading summary
app.get('/api/trading/summary', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.user.userId;

    const [positionsResponse, ordersResponse] = await Promise.all([
      fetch(`${SERVICES.POSITION}/positions`, {
        headers: { 'x-user-id': userId }
      }),
      fetch(`${SERVICES.ORDER}/orders`, {
        headers: { 'x-user-id': userId }
      })
    ]);

    const [positionsData, ordersData] = await Promise.all([
      positionsResponse.json(),
      ordersResponse.json()
    ]);

    const activePositions = positionsData.positions.filter((p: any) => p.status === 'ACTIVE');
    const totalValue = activePositions.reduce((sum: number, p: any) => sum + p.totalCost, 0);
    const totalPL = activePositions.reduce((sum: number, p: any) => sum + (p.unrealizedPL || 0), 0);
    
    const recentOrders = ordersData.orders.slice(0, 10);

    res.json({
      success: true,
      summary: {
        activePositions: activePositions.length,
        totalInvested: totalValue,
        unrealizedPL: totalPL,
        plPercent: totalValue > 0 ? (totalPL / totalValue) * 100 : 0,
        recentOrders
      }
    });

  } catch (error: any) {
    console.error('Trading summary error:', error);
    res.status(500).json({ error: 'Failed to fetch trading summary' });
  }
});

// ==================== API DOCUMENTATION ====================

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Put Options Trading API Gateway',
    version: '1.0.0',
    description: 'API Gateway for microservices-based put options trading platform',
    endpoints: {
      public: {
        '/health': 'Gateway health check',
        '/health/services': 'All services health status',
        '/api/auth/register': 'User registration',
        '/api/auth/login': 'User login',
        '/api/market/*': 'Market data (public)'
      },
      authenticated: {
        '/api/users/*': 'User management',
        '/api/accounts/*': 'Account management',
        '/api/positions/*': 'Position management',
        '/api/orders/*': 'Order management',
        '/api/risk/*': 'Risk analysis',
        '/api/ai/*': 'AI analysis (Claude + DeepSeek + MCP)',
        '/api/portfolio': 'Aggregated portfolio view',
        '/api/trading/summary': 'Trading summary'
      },
      admin: {
        '/api/admin/*': 'Admin operations'
      },
      websocket: {
        '/ws/market': 'Real-time market data stream'
      }
    },
    services: SERVICES,
    rateLimits: {
      general: '100 requests per 15 minutes',
      auth: '5 attempts per 15 minutes',
      trading: '30 trades per minute'
    }
  });
});

// Start gateway
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   PUT OPTIONS TRADING PLATFORM - API GATEWAY             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

🚀 API Gateway running on port ${PORT}

📡 Microservices:
   ├─ User Service:     ${SERVICES.USER}
   ├─ Position Service: ${SERVICES.POSITION}
   ├─ Order Service:    ${SERVICES.ORDER}
   ├─ Market Service:   ${SERVICES.MARKET}
   ├─ Risk Service:     ${SERVICES.RISK}
   ├─ Admin Service:    ${SERVICES.ADMIN}
   └─ AI Service:       ${SERVICES.AI}

🔐 Security:
   ├─ JWT Authentication
   ├─ Rate Limiting
   ├─ CORS Protection
   └─ Helmet Security Headers

📊 Features:
   ├─ Put Options Trading
   ├─ Real-time Market Data
   ├─ Risk Management
   ├─ AI Analysis (Claude + DeepSeek + MCP)
   └─ Admin Controls

🌐 Documentation: http://localhost:${PORT}/
🏥 Health Check: http://localhost:${PORT}/health

Ready to accept requests!
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});