import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const webhookRouter = express.Router();

// Rate limiter for webhook endpoints
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 webhook requests per windowMs
});

// Webhook secret for verification
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-webhook-secret';

// Verify webhook signature
function verifyWebhookSignature(payload: string, signature: string): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Webhook endpoint for external services
webhookRouter.post('/webhook/rwa-created', webhookLimiter, (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const payload = JSON.stringify(req.body);

    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { rwa_id, token_address, vault_address, creator } = req.body;

    console.log('[Webhook] RWA Created:', {
      rwa_id,
      token_address,
      vault_address,
      creator,
    });

    // Process webhook (send notifications, update database, etc.)
    handleRWACreated(req.body);

    res.json({ success: true, message: 'Webhook processed' });
  } catch (error: any) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

webhookRouter.post('/webhook/deposit', webhookLimiter, (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const payload = JSON.stringify(req.body);

    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { user, vault_address, amount, tokens_minted } = req.body;

    console.log('[Webhook] Deposit:', {
      user,
      vault_address,
      amount,
      tokens_minted,
    });

    handleDeposit(req.body);

    res.json({ success: true, message: 'Deposit webhook processed' });
  } catch (error: any) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

webhookRouter.post('/webhook/redeem', webhookLimiter, (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const payload = JSON.stringify(req.body);

    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { user, vault_address, tokens_burned, usd_returned } = req.body;

    console.log('[Webhook] Redeem:', {
      user,
      vault_address,
      tokens_burned,
      usd_returned,
    });

    handleRedeem(req.body);

    res.json({ success: true, message: 'Redeem webhook processed' });
  } catch (error: any) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handler functions with full implementations
import { db } from '../models/database';
import nodemailer from 'nodemailer';

// Email setup
const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to: string, subject: string, html: string) {
  if (!process.env.SMTP_USER) {
    console.log('[Email] SMTP not configured, skipping email');
    return;
  }
  
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });
    console.log(`[Email] Sent to ${to}: ${subject}`);
  } catch (error) {
    console.error('[Email] Error:', error);
  }
}

async function handleRWACreated(data: any) {
  console.log('[Handler] Processing RWA creation:', data.rwa_id);
  
  // Store in database
  await db.saveRWAAsset({
    id: parseInt(data.rwa_id),
    token_address: data.token_address,
    vault_address: data.vault_address,
    name: data.name || 'Unknown',
    symbol: data.symbol || 'UNK',
    asset_type: data.asset_type || 'Unknown',
    par_value: data.par_value || '0',
    yield_bps: parseInt(data.yield_bps || '0'),
    inflation_indexed: data.inflation_indexed || false,
    total_supply_cap: data.total_supply_cap || '0',
    creator: data.creator,
    created_at: Date.now(),
    is_active: true,
  });
  
  // Send notification email to creator
  const creatorEmail = await getEmailForAddress(data.creator);
  if (creatorEmail) {
    await sendEmail(
      creatorEmail,
      'RWA Asset Created Successfully',
      `
        <h2>Your RWA Asset is Live!</h2>
        <p>Asset ID: ${data.rwa_id}</p>
        <p>Token: ${data.token_address}</p>
        <p>Vault: ${data.vault_address}</p>
        <p><a href="https://app.example.com/assets/${data.rwa_id}">View Asset</a></p>
      `
    );
  }
  
  // Update analytics
  await updateAnalyticsDashboard('rwa_created', data);
}

async function handleDeposit(data: any) {
  console.log('[Handler] Processing deposit for user:', data.user);
  
  // Update user position in database
  const existingPosition = await db.getUserPosition(data.user, data.vault_address);
  
  if (existingPosition) {
    await db.updateUserPosition(data.user, data.vault_address, {
      token_balance: (BigInt(existingPosition.token_balance) + BigInt(data.tokens_minted)).toString(),
      deposit_usd_value: (BigInt(existingPosition.deposit_usd_value) + BigInt(data.amount)).toString(),
      last_updated: Date.now(),
    });
  } else {
    await db.saveUserPosition({
      user_address: data.user,
      vault_address: data.vault_address,
      token_balance: data.tokens_minted,
      deposit_usd_value: data.amount,
      entry_cpi: data.entry_cpi || '0',
      yield_debt: '0',
      total_yield_claimed: '0',
      last_updated: Date.now(),
    });
  }
  
  // Save transaction
  await db.saveTransaction({
    id: `${data.vault_address}-${Date.now()}`,
    tx_hash: data.tx_hash || '',
    block_number: data.block_number || 0,
    timestamp: Date.now(),
    type: 'deposit',
    user_address: data.user,
    vault_address: data.vault_address,
    amount: data.amount,
    data: data,
  });
  
  // Update vault TVL metrics
  await updateVaultMetrics(data.vault_address, 'deposit', data.amount);
  
  // Send confirmation email
  const userEmail = await getEmailForAddress(data.user);
  if (userEmail) {
    const amountUSD = (parseInt(data.amount) / 1000000).toFixed(2);
    await sendEmail(
      userEmail,
      'Deposit Confirmed',
      `
        <h2>Deposit Successful</h2>
        <p>Amount: $${amountUSD}</p>
        <p>Tokens Received: ${(BigInt(data.tokens_minted) / BigInt(10**18)).toString()}</p>
        <p>Vault: ${data.vault_address}</p>
        <p><a href="https://app.example.com/portfolio">View Portfolio</a></p>
      `
    );
  }
}

async function handleRedeem(data: any) {
  console.log('[Handler] Processing redemption for user:', data.user);
  
  // Update user position in database
  const existingPosition = await db.getUserPosition(data.user, data.vault_address);
  
  if (existingPosition) {
    const newBalance = BigInt(existingPosition.token_balance) - BigInt(data.tokens_burned);
    
    if (newBalance <= 0n) {
      // Fully redeemed - could delete position or mark as inactive
      await db.updateUserPosition(data.user, data.vault_address, {
        token_balance: '0',
        last_updated: Date.now(),
      });
    } else {
      await db.updateUserPosition(data.user, data.vault_address, {
        token_balance: newBalance.toString(),
        last_updated: Date.now(),
      });
    }
  }
  
  // Save transaction
  await db.saveTransaction({
    id: `${data.vault_address}-${Date.now()}`,
    tx_hash: data.tx_hash || '',
    block_number: data.block_number || 0,
    timestamp: Date.now(),
    type: 'redeem',
    user_address: data.user,
    vault_address: data.vault_address,
    amount: data.usd_returned,
    data: data,
  });
  
  // Update vault TVL metrics
  await updateVaultMetrics(data.vault_address, 'redeem', data.usd_returned);
  
  // Send confirmation email
  const userEmail = await getEmailForAddress(data.user);
  if (userEmail) {
    const amountUSD = (parseInt(data.usd_returned) / 1000000).toFixed(2);
    await sendEmail(
      userEmail,
      'Redemption Completed',
      `
        <h2>Redemption Successful</h2>
        <p>Amount Received: $${amountUSD}</p>
        <p>Tokens Burned: ${(BigInt(data.tokens_burned) / BigInt(10**18)).toString()}</p>
        <p>Vault: ${data.vault_address}</p>
        <p><a href="https://app.example.com/portfolio">View Portfolio</a></p>
      `
    );
  }
}

// Helper functions
async function getEmailForAddress(address: string): Promise<string | null> {
  // Query user email from database (users table)
  try {
    const { db } = await import('../models/database');
    // If using PostgreSQL with users table:
    if (db instanceof (await import('../models/database')).PostgreSQLDatabase) {
      const pool = (db as any).pool;
      const result = await pool.query(
        'SELECT email FROM users WHERE wallet_address = $1 AND email_verified = true',
        [address.toLowerCase()]
      );
      return result.rows[0]?.email || null;
    }
    // In-memory fallback: no email storage
    return null;
  } catch (error) {
    console.error('[Email] Error fetching email:', error);
    return null;
  }
}

async function updateVaultMetrics(vaultAddress: string, action: 'deposit' | 'redeem', amount: string) {
  const metrics = await db.getVaultMetrics(vaultAddress);
  
  const amountBigInt = BigInt(amount);
  
  if (metrics) {
    const newTVL = action === 'deposit'
      ? BigInt(metrics.tvl) + amountBigInt
      : BigInt(metrics.tvl) - amountBigInt;
    
    const newDeposited = action === 'deposit'
      ? BigInt(metrics.total_deposited) + amountBigInt
      : BigInt(metrics.total_deposited);
    
    const newRedeemed = action === 'redeem'
      ? BigInt(metrics.total_redeemed) + amountBigInt
      : BigInt(metrics.total_redeemed);
    
    await db.saveVaultMetrics({
      vault_address: vaultAddress,
      tvl: newTVL.toString(),
      total_deposited: newDeposited.toString(),
      total_redeemed: newRedeemed.toString(),
      unique_depositors: metrics.unique_depositors,
      total_yield_distributed: metrics.total_yield_distributed,
      last_updated: Date.now(),
    });
  } else {
    // First deposit/redeem for this vault
    await db.saveVaultMetrics({
      vault_address: vaultAddress,
      tvl: action === 'deposit' ? amount : '0',
      total_deposited: action === 'deposit' ? amount : '0',
      total_redeemed: action === 'redeem' ? amount : '0',
      unique_depositors: 1,
      total_yield_distributed: '0',
      last_updated: Date.now(),
    });
  }
}

async function updateAnalyticsDashboard(eventType: string, data: any) {
  // Store analytics event in database
  try {
    const { db } = await import('../models/database');
    
    // Track in analytics_events table
    if (db instanceof (await import('../models/database')).PostgreSQLDatabase) {
      const pool = (db as any).pool;
      await pool.query(
        `INSERT INTO analytics_events (event_type, event_data, timestamp)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [eventType, JSON.stringify(data), Date.now()]
      );
    }
    
    // Send to external analytics (Mixpanel example)
    if (process.env.MIXPANEL_TOKEN) {
      const Mixpanel = require('mixpanel');
      const mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN);
      
      mixpanel.track(eventType, {
        distinct_id: data.user || data.creator || 'system',
        ...data,
        timestamp: new Date().toISOString(),
      });
    }
    
    // Send to Amplitude
    if (process.env.AMPLITUDE_API_KEY) {
      const amplitude = require('@amplitude/node');
      const client = amplitude.init(process.env.AMPLITUDE_API_KEY);
      
      client.logEvent({
        event_type: eventType,
        user_id: data.user || data.creator || 'system',
        event_properties: data,
      });
    }
    
    console.log('[Analytics]', eventType, 'tracked');
  } catch (error) {
    console.error('[Analytics] Error:', error);
  }
}

export default webhookRouter;
