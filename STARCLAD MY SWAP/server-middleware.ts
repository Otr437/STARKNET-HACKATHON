/**
 * Server Middleware - Rate Limiting, Authentication, and Validation
 * Production-grade security middleware
 */

import { Request, Response, NextFunction } from 'express';
import { SecureKeyManager } from './encryption';
import Redis from 'ioredis';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      id?: string;
      startTime?: number;
      apiKey?: ApiKeyData;
      rateLimitInfo?: {
        limit: number;
        remaining: number;
        resetAt: number;
      };
    }
  }
}

interface ApiKeyData {
  key: string;
  name: string;
  permissions: string[];
  rateLimit: number;
  createdAt: number;
  lastUsed: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class ServerMiddleware {
  private keyManager: SecureKeyManager;
  private redis: Redis;
  private rateLimitMap: Map<string, RateLimitEntry> = new Map();
  private apiKeys: Map<string, ApiKeyData> = new Map();
  private readonly maxRequestsPerMinute: number;

  constructor(keyManager: SecureKeyManager, redis: Redis, maxRequestsPerMinute: number = 100) {
    this.keyManager = keyManager;
    this.redis = redis;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
  }

  /**
   * Rate limiting middleware with Redis backend
   */
  async rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get identifier (API key or IP)
      const identifier = req.apiKey?.key || req.ip || 'unknown';
      
      // Get rate limit for this identifier
      const limit = req.apiKey?.rateLimit || this.maxRequestsPerMinute;
      
      // Check Redis first (distributed rate limiting)
      const key = `ratelimit:${identifier}`;
      const current = await this.redis.get(key);
      
      if (current) {
        const count = parseInt(current, 10);
        
        if (count >= limit) {
          const ttl = await this.redis.ttl(key);
          
          res.setHeader('X-RateLimit-Limit', limit.toString());
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-Reset', (Date.now() + ttl * 1000).toString());
          res.setHeader('Retry-After', ttl.toString());
          
          res.status(429).json({
            error: 'Too many requests',
            message: `Rate limit exceeded. Try again in ${ttl} seconds.`,
            retryAfter: ttl
          });
          return;
        }
        
        // Increment counter
        await this.redis.incr(key);
        const remaining = limit - count - 1;
        
        res.setHeader('X-RateLimit-Limit', limit.toString());
        res.setHeader('X-RateLimit-Remaining', remaining.toString());
        res.setHeader('X-RateLimit-Reset', (Date.now() + 60000).toString());
        
        req.rateLimitInfo = {
          limit,
          remaining,
          resetAt: Date.now() + 60000
        };
      } else {
        // First request in this window
        await this.redis.setex(key, 60, '1'); // 60 second window
        
        res.setHeader('X-RateLimit-Limit', limit.toString());
        res.setHeader('X-RateLimit-Remaining', (limit - 1).toString());
        res.setHeader('X-RateLimit-Reset', (Date.now() + 60000).toString());
        
        req.rateLimitInfo = {
          limit,
          remaining: limit - 1,
          resetAt: Date.now() + 60000
        };
      }
      
      next();
    } catch (error) {
      console.error('Rate limit error:', error);
      // Fail open - allow request if rate limiting fails
      next();
    }
  }

  /**
   * API key authentication middleware
   */
  async apiKeyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Extract API key from header
      const apiKey = req.header('X-API-Key') || req.header('Authorization')?.replace('Bearer ', '');
      
      if (!apiKey) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'API key required'
        });
        return;
      }
      
      // Validate API key
      const keyData = await this.validateApiKey(apiKey);
      
      if (!keyData) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid API key'
        });
        return;
      }
      
      // Check permissions for this endpoint
      const requiredPermission = this.getRequiredPermission(req.path, req.method);
      if (requiredPermission && !keyData.permissions.includes(requiredPermission) && !keyData.permissions.includes('*')) {
        res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient permissions. Required: ${requiredPermission}`
        });
        return;
      }
      
      // Attach key data to request
      req.apiKey = keyData;
      
      // Update last used timestamp
      await this.updateApiKeyUsage(apiKey);
      
      next();
    } catch (error) {
      console.error('API key validation error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to validate API key'
      });
    }
  }

  /**
   * Validate API key and return associated data
   */
  private async validateApiKey(key: string): Promise<ApiKeyData | null> {
    // Check memory cache first
    if (this.apiKeys.has(key)) {
      return this.apiKeys.get(key)!;
    }
    
    // Check Redis
    const keyData = await this.redis.get(`apikey:${key}`);
    if (!keyData) {
      return null;
    }
    
    try {
      const decrypted = this.keyManager.decrypt(keyData, 'api_keys');
      const parsed: ApiKeyData = JSON.parse(decrypted);
      
      // Cache in memory
      this.apiKeys.set(key, parsed);
      
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Update API key last used timestamp
   */
  private async updateApiKeyUsage(key: string): Promise<void> {
    const keyData = this.apiKeys.get(key);
    if (!keyData) return;
    
    keyData.lastUsed = Date.now();
    this.apiKeys.set(key, keyData);
    
    // Update in Redis (fire and forget)
    const encrypted = this.keyManager.encrypt(JSON.stringify(keyData), 'api_keys');
    this.redis.set(`apikey:${key}`, encrypted).catch(console.error);
  }

  /**
   * Get required permission for endpoint
   */
  private getRequiredPermission(path: string, method: string): string | null {
    const permissions: Record<string, string> = {
      'POST /api/notes/generate': 'notes:create',
      'POST /api/proofs/spend': 'proofs:generate',
      'POST /api/swaps/initiate': 'swaps:initiate',
      'POST /api/swaps/lock': 'swaps:lock',
      'POST /api/swaps/complete': 'swaps:complete',
      'POST /api/swaps/refund': 'swaps:refund',
      'GET /api/swaps/:swapId': 'swaps:read',
      'POST /api/btc/spv-proof': 'bitcoin:spv',
      'POST /api/starknet/commit-note': 'starknet:write',
      'GET /api/starknet/nullifier/:nullifier': 'starknet:read'
    };
    
    // Match path pattern
    for (const [pattern, permission] of Object.entries(permissions)) {
      const [patternMethod, patternPath] = pattern.split(' ');
      if (method === patternMethod && this.matchPath(path, patternPath)) {
        return permission;
      }
    }
    
    return null;
  }

  /**
   * Match path with pattern (supports :param syntax)
   */
  private matchPath(path: string, pattern: string): boolean {
    const pathParts = path.split('/');
    const patternParts = pattern.split('/');
    
    if (pathParts.length !== patternParts.length) {
      return false;
    }
    
    for (let i = 0; i < pathParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        continue; // Wildcard match
      }
      if (pathParts[i] !== patternParts[i]) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Create new API key
   */
  async createApiKey(name: string, permissions: string[], rateLimit?: number): Promise<string> {
    const key = this.keyManager.generateSecureToken(32);
    
    const keyData: ApiKeyData = {
      key,
      name,
      permissions,
      rateLimit: rateLimit || this.maxRequestsPerMinute,
      createdAt: Date.now(),
      lastUsed: 0
    };
    
    // Store in Redis
    const encrypted = this.keyManager.encrypt(JSON.stringify(keyData), 'api_keys');
    await this.redis.set(`apikey:${key}`, encrypted);
    
    // Cache in memory
    this.apiKeys.set(key, keyData);
    
    return key;
  }

  /**
   * Revoke API key
   */
  async revokeApiKey(key: string): Promise<boolean> {
    // Remove from Redis
    const result = await this.redis.del(`apikey:${key}`);
    
    // Remove from memory cache
    this.apiKeys.delete(key);
    
    return result > 0;
  }

  /**
   * List all API keys
   */
  async listApiKeys(): Promise<Omit<ApiKeyData, 'key'>[]> {
    const keys = await this.redis.keys('apikey:*');
    const results: Omit<ApiKeyData, 'key'>[] = [];
    
    for (const redisKey of keys) {
      const data = await this.redis.get(redisKey);
      if (data) {
        try {
          const decrypted = this.keyManager.decrypt(data, 'api_keys');
          const parsed: ApiKeyData = JSON.parse(decrypted);
          
          // Omit the actual key for security
          const { key, ...rest } = parsed;
          results.push(rest);
        } catch {
          continue;
        }
      }
    }
    
    return results;
  }

  /**
   * Load API keys from Redis into memory cache
   */
  async loadApiKeys(): Promise<void> {
    const keys = await this.redis.keys('apikey:*');
    
    for (const redisKey of keys) {
      const data = await this.redis.get(redisKey);
      if (data) {
        try {
          const decrypted = this.keyManager.decrypt(data, 'api_keys');
          const parsed: ApiKeyData = JSON.parse(decrypted);
          this.apiKeys.set(parsed.key, parsed);
        } catch {
          console.warn(`Failed to load API key: ${redisKey}`);
        }
      }
    }
    
    console.log(`✅ Loaded ${this.apiKeys.size} API keys`);
  }
}
