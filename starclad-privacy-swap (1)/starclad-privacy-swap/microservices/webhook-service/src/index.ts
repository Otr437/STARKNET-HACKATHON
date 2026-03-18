import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import { createHmac, randomBytes } from 'crypto';
import { Queue, Worker, QueueEvents } from 'bullmq';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(express.json());

const testWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 test requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const createSubscriptionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 subscription creation requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const subscriptionWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 subscription write operations per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const deliveriesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 delivery history requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/privacy_swap',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// BullMQ queue for webhook delivery
const webhookQueue = new Queue('webhooks', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

const queueEvents = new QueueEvents('webhooks', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  maxRetries: number;
  retryDelay: number;
  exponentialBackoff: boolean;
}

interface WebhookPayload {
  event: string;
  data: any;
  timestamp: number;
  deliveryId: string;
}

// Generate HMAC signature for webhook payload
function generateSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

// Deliver webhook with retry logic
async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: WebhookPayload,
  attempt: number = 1
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  try {
    const payloadString = JSON.stringify(payload);
    const signature = generateSignature(payloadString, subscription.secret);

    const response = await axios.post(
      subscription.url,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Delivery-Id': payload.deliveryId,
          'X-Webhook-Event': payload.event,
          'X-Webhook-Attempt': attempt.toString(),
        },
        timeout: 30000,
        validateStatus: (status) => status >= 200 && status < 300,
      }
    );

    // Log successful delivery
    await pool.query(
      `INSERT INTO webhook_deliveries (
        subscription_id, delivery_id, event, payload, status_code,
        success, attempt, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        subscription.id,
        payload.deliveryId,
        payload.event,
        payloadString,
        response.status,
        true,
        attempt,
      ]
    );

    return { success: true, statusCode: response.status };
  } catch (error) {
    const statusCode = error.response?.status;
    const errorMessage = error.message;

    // Log failed delivery
    await pool.query(
      `INSERT INTO webhook_deliveries (
        subscription_id, delivery_id, event, payload, status_code,
        success, attempt, error_message, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        subscription.id,
        payload.deliveryId,
        payload.event,
        JSON.stringify(payload),
        statusCode || null,
        false,
        attempt,
        errorMessage,
      ]
    );

    return { success: false, statusCode, error: errorMessage };
  }
}

// BullMQ worker to process webhook deliveries
const webhookWorker = new Worker(
  'webhooks',
  async (job) => {
    const { subscription, payload } = job.data;
    const attempt = job.attemptsMade + 1;

    const result = await deliverWebhook(subscription, payload, attempt);

    if (!result.success && attempt < subscription.maxRetries) {
      // Retry with exponential backoff
      const delay = subscription.exponentialBackoff
        ? subscription.retryDelay * Math.pow(2, attempt - 1)
        : subscription.retryDelay;

      throw new Error(`Delivery failed, will retry in ${delay}ms`);
    }

    return result;
  },
  {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    },
    limiter: {
      max: 100,
      duration: 1000,
    },
  }
);

webhookWorker.on('completed', async (job) => {
  console.log(`Webhook delivery completed: ${job.data.payload.deliveryId}`);
});

webhookWorker.on('failed', async (job, err) => {
  console.error(`Webhook delivery failed permanently: ${job.data.payload.deliveryId}`, err);
  
  // Mark subscription as failed if too many failures
  const failureCount = await redis.incr(`webhook:failures:${job.data.subscription.id}`);
  await redis.expire(`webhook:failures:${job.data.subscription.id}`, 3600);

  if (failureCount > 10) {
    await pool.query(
      `UPDATE webhook_subscriptions SET active = false WHERE id = $1`,
      [job.data.subscription.id]
    );
    console.log(`Disabled subscription ${job.data.subscription.id} due to excessive failures`);
  }
});

// Subscribe to Redis pub/sub events
async function subscribeToEvents() {
  const events = [
    'proof:generated',
    'merkle:commitment:added',
    'btc:commitment:detected',
    'eth:commitment:added',
    'eth:swap:initiated',
    'eth:swap:completed',
    'starknet:commitment:added',
  ];

  for (const event of events) {
    await redisSub.subscribe(event);
  }

  redisSub.on('message', async (channel, message) => {
    const eventData = JSON.parse(message);
    await processEvent(channel, eventData);
  });

  console.log('Subscribed to events:', events.join(', '));
}

// Process event and trigger webhooks
async function processEvent(event: string, data: any) {
  try {
    // Get all active subscriptions for this event
    const result = await pool.query(
      `SELECT * FROM webhook_subscriptions 
       WHERE active = true AND $1 = ANY(events)`,
      [event]
    );

    for (const row of result.rows) {
      const subscription: WebhookSubscription = {
        id: row.id,
        url: row.url,
        events: row.events,
        secret: row.secret,
        active: row.active,
        maxRetries: row.max_retries || 3,
        retryDelay: row.retry_delay || 5000,
        exponentialBackoff: row.exponential_backoff !== false,
      };

      const payload: WebhookPayload = {
        event,
        data,
        timestamp: Date.now(),
        deliveryId: randomBytes(16).toString('hex'),
      };

      // Add to queue with retry configuration
      await webhookQueue.add(
        'deliver',
        { subscription, payload },
        {
          attempts: subscription.maxRetries,
          backoff: {
            type: subscription.exponentialBackoff ? 'exponential' : 'fixed',
            delay: subscription.retryDelay,
          },
        }
      );
    }
  } catch (error) {
    console.error('Error processing event:', error);
  }
}

// API endpoints

// Create webhook subscription
app.post('/subscriptions', createSubscriptionLimiter, async (req, res) => {
  try {
    const { url, events, maxRetries = 3, retryDelay = 5000, exponentialBackoff = true } = req.body;

    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'Invalid subscription data' });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Generate secret
    const secret = randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO webhook_subscriptions (
        id, url, events, secret, active, max_retries, retry_delay,
        exponential_backoff, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *`,
      [
        randomBytes(16).toString('hex'),
        url,
        events,
        secret,
        true,
        maxRetries,
        retryDelay,
        exponentialBackoff,
      ]
    );

    res.json({
      id: result.rows[0].id,
      url: result.rows[0].url,
      events: result.rows[0].events,
      secret: result.rows[0].secret,
      active: result.rows[0].active,
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get subscription
app.get('/subscriptions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM webhook_subscriptions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update subscription
app.put('/subscriptions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { url, events, active } = req.body;

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (url !== undefined) {
      updates.push(`url = $${paramCount++}`);
      values.push(url);
    }
    if (events !== undefined) {
      updates.push(`events = $${paramCount++}`);
      values.push(events);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE webhook_subscriptions SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete subscription
app.delete('/subscriptions/:id', subscriptionWriteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM webhook_subscriptions WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get delivery history
app.get('/subscriptions/:id/deliveries', deliveriesLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT * FROM webhook_deliveries
       WHERE subscription_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test webhook endpoint
app.post('/test/:id', testWebhookLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `SELECT * FROM webhook_subscriptions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const subscription = result.rows[0];
    const testPayload: WebhookPayload = {
      event: 'test',
      data: { message: 'This is a test webhook' },
      timestamp: Date.now(),
      deliveryId: randomBytes(16).toString('hex'),
    };

    const deliveryResult = await deliverWebhook(subscription, testPayload, 1);
    res.json(deliveryResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'webhook' });
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, async () => {
  console.log(`Webhook service running on port ${PORT}`);
  await subscribeToEvents();
});
