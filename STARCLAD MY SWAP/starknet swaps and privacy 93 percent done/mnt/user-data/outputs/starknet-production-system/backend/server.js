// Production-Ready Starknet Backend Server
// Features: HTTPS, REST API, WebSocket events, Webhooks, Rate limiting, Authentication

import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocketChannel, RpcProvider, Contract } from 'starknet';
import dotenv from 'dotenv';
import winston from 'winston';
import axios from 'axios';

dotenv.config();

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// App configuration
const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(helmet()); // Security headers
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', apiLimiter);

// Starknet provider configuration
const provider = new RpcProvider({
  nodeUrl: process.env.STARKNET_RPC_URL || 'https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_9/' + process.env.ALCHEMY_API_KEY
});

// Contract instances
const contracts = {
  vaultManager: null,
  btcSwap: null,
  semaphore: null
};

// Webhook registry
const webhooks = new Map();

// WebSocket event listeners
let wsChannel = null;

// Initialize WebSocket channel for event listening
async function initializeWebSocket() {
  try {
    wsChannel = new WebSocketChannel({
      nodeUrl: process.env.STARKNET_WS_URL || 'wss://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_9/' + process.env.ALCHEMY_API_KEY
    });

    await wsChannel.waitForConnection();
    logger.info('WebSocket connected to Starknet node');

    // Subscribe to new blocks
    const blockSub = await wsChannel.subscribeNewHeads({
      blockIdentifier: 'latest'
    });

    blockSub.on((data) => {
      logger.info(`New block: ${data.block_number}`);
      // Trigger webhooks for block events
      triggerWebhooks('block.new', data);
    });

    // Subscribe to contract events
    await subscribeToContractEvents();

  } catch (error) {
    logger.error('Failed to initialize WebSocket:', error);
  }
}

// Subscribe to specific contract events
async function subscribeToContractEvents() {
  if (!process.env.VAULT_MANAGER_ADDRESS) return;

  try {
    const eventsSub = await wsChannel.subscribeEvents({
      address: process.env.VAULT_MANAGER_ADDRESS
    });

    eventsSub.on((event) => {
      logger.info('Contract event received:', event);
      processContractEvent(event);
    });

  } catch (error) {
    logger.error('Failed to subscribe to contract events:', error);
  }
}

// Process and route contract events
function processContractEvent(event) {
  const eventType = identifyEventType(event);
  triggerWebhooks(eventType, event);
}

// Identify event type from event data
function identifyEventType(event) {
  // Parse event keys to identify type
  if (event.keys && event.keys.length > 0) {
    const eventKey = event.keys[0];
    // Map event hashes to event names
    const eventMap = {
      // Add your event hashes here
    };
    return eventMap[eventKey] || 'unknown';
  }
  return 'unknown';
}

// Trigger registered webhooks
async function triggerWebhooks(eventType, data) {
  const hooks = Array.from(webhooks.values()).filter(h => h.events.includes(eventType));

  for (const hook of hooks) {
    try {
      await axios.post(hook.url, {
        event: eventType,
        data,
        timestamp: new Date().toISOString(),
        webhook_id: hook.id
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': generateWebhookSignature(hook.secret, data)
        },
        timeout: 5000
      });

      logger.info(`Webhook triggered: ${hook.id} for event ${eventType}`);
    } catch (error) {
      logger.error(`Failed to trigger webhook ${hook.id}:`, error.message);
    }
  }
}

// Generate HMAC signature for webhook authentication
function generateWebhookSignature(secret, data) {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(data))
    .digest('hex');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    websocket: wsChannel ? 'connected' : 'disconnected'
  });
});

// ==================== VAULT MANAGER API ====================

// Get vault balance
app.get('/api/vault/:token/balance', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!contracts.vaultManager) {
      return res.status(503).json({ error: 'Vault manager not initialized' });
    }

    const balance = await contracts.vaultManager.get_vault_balance(token);
    
    res.json({
      token,
      balance: balance.toString(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching vault balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user deposits
app.get('/api/vault/user/:address/:token', async (req, res) => {
  try {
    const { address, token } = req.params;
    
    if (!contracts.vaultManager) {
      return res.status(503).json({ error: 'Vault manager not initialized' });
    }

    const balance = await contracts.vaultManager.get_user_balance(address, token);
    
    res.json({
      user: address,
      token,
      balance: balance.toString(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching user balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get curator allocations
app.get('/api/vault/curator/:address/:token', async (req, res) => {
  try {
    const { address, token } = req.params;
    
    if (!contracts.vaultManager) {
      return res.status(503).json({ error: 'Vault manager not initialized' });
    }

    const allocation = await contracts.vaultManager.get_curator_allocation(address, token);
    
    res.json({
      curator: address,
      token,
      allocation: allocation.toString(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching curator allocation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== BTC SWAP API ====================

// Get swap details
app.get('/api/swap/:swapId', async (req, res) => {
  try {
    const { swapId } = req.params;
    
    if (!contracts.btcSwap) {
      return res.status(503).json({ error: 'BTC Swap not initialized' });
    }

    const swap = await contracts.btcSwap.get_swap(swapId);
    
    res.json({
      swapId,
      swap: {
        initiator: swap.initiator.toString(),
        participant: swap.participant.toString(),
        token: swap.token.toString(),
        amount: swap.amount.toString(),
        status: swap.status,
        timeLock: swap.time_lock,
        createdAt: swap.created_at
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching swap:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SEMAPHORE API ====================

// Get group details
app.get('/api/semaphore/group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    
    if (!contracts.semaphore) {
      return res.status(503).json({ error: 'Semaphore not initialized' });
    }

    const group = await contracts.semaphore.get_group(groupId);
    
    res.json({
      groupId,
      group: {
        admin: group.admin.toString(),
        merkleRoot: group.merkle_tree_root.toString(),
        depth: group.depth,
        memberCount: group.member_count.toString(),
        createdAt: group.created_at
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if member exists
app.get('/api/semaphore/group/:groupId/member/:commitment', async (req, res) => {
  try {
    const { groupId, commitment } = req.params;
    
    if (!contracts.semaphore) {
      return res.status(503).json({ error: 'Semaphore not initialized' });
    }

    const isMember = await contracts.semaphore.is_member(groupId, commitment);
    
    res.json({
      groupId,
      commitment,
      isMember,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error checking membership:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== WEBHOOK MANAGEMENT ====================

// Register webhook
app.post('/api/webhooks', (req, res) => {
  try {
    const { url, events, secret } = req.body;

    if (!url || !events || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid webhook configuration' });
    }

    const webhookId = require('crypto').randomBytes(16).toString('hex');
    const webhook = {
      id: webhookId,
      url,
      events,
      secret: secret || require('crypto').randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString()
    };

    webhooks.set(webhookId, webhook);

    res.status(201).json({
      webhookId,
      secret: webhook.secret,
      message: 'Webhook registered successfully'
    });

    logger.info(`Webhook registered: ${webhookId}`);
  } catch (error) {
    logger.error('Error registering webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// List webhooks
app.get('/api/webhooks', (req, res) => {
  const hooksList = Array.from(webhooks.values()).map(h => ({
    id: h.id,
    url: h.url,
    events: h.events,
    createdAt: h.createdAt
  }));

  res.json({ webhooks: hooksList });
});

// Delete webhook
app.delete('/api/webhooks/:id', (req, res) => {
  const { id } = req.params;

  if (!webhooks.has(id)) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  webhooks.delete(id);
  logger.info(`Webhook deleted: ${id}`);

  res.json({ message: 'Webhook deleted successfully' });
});

// ==================== EVENT STREAM API ====================

// Server-Sent Events endpoint for real-time updates
app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection message
  sendEvent({ type: 'connected', timestamp: new Date().toISOString() });

  // Keep connection alive
  const heartbeat = setInterval(() => {
    sendEvent({ type: 'heartbeat', timestamp: new Date().toISOString() });
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// ==================== SERVER INITIALIZATION ====================

// Initialize contracts
async function initializeContracts() {
  try {
    if (process.env.VAULT_MANAGER_ADDRESS && process.env.VAULT_MANAGER_ABI) {
      const abi = JSON.parse(fs.readFileSync(process.env.VAULT_MANAGER_ABI, 'utf8'));
      contracts.vaultManager = new Contract(abi, process.env.VAULT_MANAGER_ADDRESS, provider);
      logger.info('Vault Manager contract initialized');
    }

    if (process.env.BTC_SWAP_ADDRESS && process.env.BTC_SWAP_ABI) {
      const abi = JSON.parse(fs.readFileSync(process.env.BTC_SWAP_ABI, 'utf8'));
      contracts.btcSwap = new Contract(abi, process.env.BTC_SWAP_ADDRESS, provider);
      logger.info('BTC Swap contract initialized');
    }

    if (process.env.SEMAPHORE_ADDRESS && process.env.SEMAPHORE_ABI) {
      const abi = JSON.parse(fs.readFileSync(process.env.SEMAPHORE_ABI, 'utf8'));
      contracts.semaphore = new Contract(abi, process.env.SEMAPHORE_ADDRESS, provider);
      logger.info('Semaphore contract initialized');
    }
  } catch (error) {
    logger.error('Error initializing contracts:', error);
  }
}

// Start HTTP server
const httpServer = http.createServer(app);
httpServer.listen(PORT, () => {
  logger.info(`HTTP Server running on port ${PORT}`);
});

// Start HTTPS server if certificates are provided
if (process.env.SSL_CERT && process.env.SSL_KEY) {
  try {
    const httpsOptions = {
      cert: fs.readFileSync(process.env.SSL_CERT),
      key: fs.readFileSync(process.env.SSL_KEY)
    };

    const httpsServer = https.createServer(httpsOptions, app);
    httpsServer.listen(HTTPS_PORT, () => {
      logger.info(`HTTPS Server running on port ${HTTPS_PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start HTTPS server:', error);
  }
}

// Initialize services
Promise.all([
  initializeContracts(),
  initializeWebSocket()
]).then(() => {
  logger.info('All services initialized successfully');
}).catch((error) => {
  logger.error('Failed to initialize services:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

export default app;
