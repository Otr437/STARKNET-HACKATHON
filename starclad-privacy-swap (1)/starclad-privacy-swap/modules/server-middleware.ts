/**
 * ServerMiddleware - Production security middleware
 * Redis rate limiting, API key auth with permissions, Zod input validation, request logging
 */
import { type Request, type Response, type NextFunction } from 'express';
import { z, type ZodSchema } from 'zod';
import type Redis from 'ioredis';
import { SecureKeyManager } from './encryption';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      startTime?: number;
      apiKey?: ApiKeyData;
      rateLimitInfo?: { limit: number; remaining: number; resetAt: number };
    }
  }
}

interface ApiKeyData {
  key: string; name: string; permissions: string[];
  rateLimit: number; createdAt: number; lastUsed: number;
}

// ── Zod schemas for all routes ──────────────────────────────────────────────
export const Schemas = {
  generateNote: z.object({
    amount: z.coerce.bigint().positive(),
    recipient: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'Invalid felt252 address'),
    secret: z.string().regex(/^[0-9a-fA-F]{62}$/).optional(),
  }),
  spendProof: z.object({
    commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    spender: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  }),
  initiateSwap: z.object({
    initiator: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    recipient: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    amount: z.coerce.bigint().positive(),
    timelockDuration: z.number().int().min(300).max(86400 * 30),
  }),
  lockSwap: z.object({ swapId: z.string(), btcTxid: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/) }),
  completeSwap: z.object({ swapId: z.string(), secret: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/) }),
  refundSwap: z.object({ swapId: z.string() }),
  spvProof: z.object({ txid: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/) }),
};

export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(422).json({ error: 'Validation failed', details: result.error.issues });
      return;
    }
    (req as any).validated = result.data;
    next();
  };
}

// ── Middleware class ─────────────────────────────────────────────────────────
export class ServerMiddleware {
  private apiKeys = new Map<string, ApiKeyData>();

  constructor(
    private km: SecureKeyManager,
    private redis: Redis,
    private maxRpm: number = 100,
  ) {}

  requestLogger() {
    return (req: Request, res: Response, next: NextFunction): void => {
      req.id = this.km.randomHex(8);
      req.startTime = Date.now();
      res.setHeader('X-Request-ID', req.id);
      res.on('finish', () => {
        const ms = Date.now() - (req.startTime ?? Date.now());
        const msg = `[${req.method}] ${req.path} → ${res.statusCode} (${ms}ms) [${req.id}]`;
        if (res.statusCode >= 500) console.error(msg);
        else if (res.statusCode >= 400) console.warn(msg);
        else console.log(msg);
      });
      next();
    };
  }

  rateLimiter() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const id = (req.apiKey?.key ?? req.ip) || 'anon';
      const limit = req.apiKey?.rateLimit ?? this.maxRpm;
      const key = `rl:${id}`;
      try {
        const cur = await this.redis.get(key);
        if (cur && parseInt(cur, 10) >= limit) {
          const ttl = await this.redis.ttl(key);
          res.setHeader('X-RateLimit-Limit', limit);
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('Retry-After', ttl);
          res.status(429).json({ error: 'Rate limit exceeded', retryAfter: ttl });
          return;
        }
        if (cur) { await this.redis.incr(key); }
        else { await this.redis.setex(key, 60, '1'); }
        const remaining = limit - parseInt(cur ?? '0', 10) - 1;
        res.setHeader('X-RateLimit-Limit', limit);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
      } catch { /* fail open */ }
      next();
    };
  }

  apiKeyAuth() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const raw = req.header('X-API-Key') ?? req.header('Authorization')?.replace(/^Bearer\s+/, '');
      if (!raw) { res.status(401).json({ error: 'API key required' }); return; }
      const data = await this._validateKey(raw);
      if (!data) { res.status(401).json({ error: 'Invalid API key' }); return; }
      const needed = this._requiredPermission(req.path, req.method);
      if (needed && !data.permissions.includes(needed) && !data.permissions.includes('*')) {
        res.status(403).json({ error: 'Insufficient permissions', required: needed }); return;
      }
      req.apiKey = data;
      this._touchKey(raw, data).catch(() => {});
      next();
    };
  }

  private async _validateKey(key: string): Promise<ApiKeyData | null> {
    if (this.apiKeys.has(key)) return this.apiKeys.get(key)!;
    const enc = await this.redis.get(`apikey:${key}`);
    if (!enc) return null;
    try {
      const data: ApiKeyData = JSON.parse(this.km.decrypt(enc, 'api_keys'));
      this.apiKeys.set(key, data);
      return data;
    } catch { return null; }
  }

  private async _touchKey(key: string, data: ApiKeyData): Promise<void> {
    data.lastUsed = Date.now();
    await this.redis.set(`apikey:${key}`, this.km.encrypt(JSON.stringify(data), 'api_keys'));
  }

  private _requiredPermission(path: string, method: string): string | null {
    const map: Record<string, string> = {
      'POST /api/notes/generate': 'notes:write',
      'POST /api/proofs/spend': 'proofs:generate',
      'POST /api/swaps/initiate': 'swaps:write',
      'POST /api/swaps/lock': 'swaps:write',
      'POST /api/swaps/complete': 'swaps:write',
      'POST /api/swaps/refund': 'swaps:write',
      'GET /api/swaps/stats': 'swaps:read',
      'POST /api/btc/spv-proof': 'bitcoin:read',
    };
    for (const [pattern, perm] of Object.entries(map)) {
      const [m, p] = pattern.split(' ');
      if (method === m && this._matchPath(path, p)) return perm;
    }
    return null;
  }

  private _matchPath(path: string, pattern: string): boolean {
    const pp = path.split('/'), pt = pattern.split('/');
    if (pp.length !== pt.length) return false;
    return pt.every((seg, i) => seg.startsWith(':') || seg === pp[i]);
  }

  async createApiKey(name: string, permissions: string[], rateLimit?: number): Promise<string> {
    const key = this.km.generateSecureToken(32);
    const data: ApiKeyData = { key, name, permissions, rateLimit: rateLimit ?? this.maxRpm, createdAt: Date.now(), lastUsed: 0 };
    await this.redis.set(`apikey:${key}`, this.km.encrypt(JSON.stringify(data), 'api_keys'));
    this.apiKeys.set(key, data);
    return key;
  }

  async revokeApiKey(key: string): Promise<boolean> {
    const n = await this.redis.del(`apikey:${key}`);
    this.apiKeys.delete(key);
    return n > 0;
  }

  async loadApiKeys(): Promise<void> {
    const keys = await this.redis.keys('apikey:*');
    for (const k of keys) {
      const enc = await this.redis.get(k);
      if (!enc) continue;
      try {
        const data: ApiKeyData = JSON.parse(this.km.decrypt(enc, 'api_keys'));
        this.apiKeys.set(data.key, data);
      } catch { /* skip corrupted */ }
    }
    console.log(`[Middleware] loaded ${this.apiKeys.size} API keys`);
  }
}
