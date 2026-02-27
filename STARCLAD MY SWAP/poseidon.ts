/**
 * Poseidon Hash Module - COMPLETE PRODUCTION IMPLEMENTATION
 */

import { buildPoseidon } from 'circomlibjs';

interface HashCacheEntry {
  hash: bigint;
  timestamp: number;
  hitCount: number;
}

interface BatchHashResult {
  hashes: bigint[];
  processingTime: number;
  cacheHits: number;
  cacheMisses: number;
}

interface PerformanceMetrics {
  totalHashes: number;
  cacheHits: number;
  cacheMisses: number;
  avgHashTime: number;
  batchOperations: number;
  cacheHitRate: number;
}

export class PoseidonHasher {
  private poseidon: any;
  private initialized: boolean = false;
  private readonly fieldPrime = BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001');
  
  private hashCache: Map<string, HashCacheEntry> = new Map();
  private readonly maxCacheSize: number = 10000;
  private readonly cacheExpiryMs: number = 3600000;
  
  private stats = {
    totalHashes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    avgHashTime: 0,
    batchOperations: 0
  };

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const startTime = Date.now();
      this.poseidon = await buildPoseidon();
      this.initialized = true;
      this.startCacheCleanup();
      console.log(`✅ Poseidon initialized in ${Date.now() - startTime}ms`);
    }
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [key, entry] of this.hashCache.entries()) {
        if (now - entry.timestamp > this.cacheExpiryMs) {
          this.hashCache.delete(key);
          cleaned++;
        }
      }
      
      if (this.hashCache.size > this.maxCacheSize) {
        const toDelete = this.hashCache.size - this.maxCacheSize;
        const entries = Array.from(this.hashCache.entries())
          .sort((a, b) => a[1].hitCount - b[1].hitCount)
          .slice(0, toDelete);
        
        for (const [key] of entries) {
          this.hashCache.delete(key);
        }
      }
    }, 300000);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Poseidon not initialized. Call initialize() first.');
    }
  }

  private validateFieldElement(value: bigint): void {
    if (value < 0n) {
      throw new Error('Field element must be non-negative');
    }
    if (value >= this.fieldPrime) {
      throw new Error(`Field element must be less than ${this.fieldPrime}`);
    }
  }

  private getCachedOrCompute(cacheKey: string, computeFn: () => bigint): bigint {
    const cached = this.hashCache.get(cacheKey);
    if (cached) {
      cached.hitCount++;
      cached.timestamp = Date.now();
      this.stats.cacheHits++;
      return cached.hash;
    }
    
    const startTime = performance.now();
    const hash = computeFn();
    const duration = performance.now() - startTime;
    
    this.hashCache.set(cacheKey, {
      hash,
      timestamp: Date.now(),
      hitCount: 1
    });
    
    this.stats.cacheMisses++;
    this.stats.totalHashes++;
    this.stats.avgHashTime = 
      (this.stats.avgHashTime * (this.stats.totalHashes - 1) + duration) / this.stats.totalHashes;
    
    return hash;
  }

  hash(input: bigint, useCache: boolean = true): bigint {
    this.ensureInitialized();
    this.validateFieldElement(input);
    
    if (!useCache) {
      const hash = this.poseidon([input]);
      return this.poseidon.F.toObject(hash);
    }
    
    const cacheKey = `h1:${input.toString()}`;
    return this.getCachedOrCompute(cacheKey, () => {
      const hash = this.poseidon([input]);
      return this.poseidon.F.toObject(hash);
    });
  }

  hash2(inputs: [bigint, bigint], useCache: boolean = true): bigint {
    this.ensureInitialized();
    inputs.forEach(input => this.validateFieldElement(input));
    
    if (!useCache) {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    }
    
    const cacheKey = `h2:${inputs[0].toString()}:${inputs[1].toString()}`;
    return this.getCachedOrCompute(cacheKey, () => {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    });
  }

  hash3(inputs: [bigint, bigint, bigint], useCache: boolean = true): bigint {
    this.ensureInitialized();
    inputs.forEach(input => this.validateFieldElement(input));
    
    if (!useCache) {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    }
    
    const cacheKey = `h3:${inputs.join(':')}`;
    return this.getCachedOrCompute(cacheKey, () => {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    });
  }

  hash4(inputs: [bigint, bigint, bigint, bigint], useCache: boolean = true): bigint {
    this.ensureInitialized();
    inputs.forEach(input => this.validateFieldElement(input));
    
    if (!useCache) {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    }
    
    const cacheKey = `h4:${inputs.join(':')}`;
    return this.getCachedOrCompute(cacheKey, () => {
      const hash = this.poseidon(inputs);
      return this.poseidon.F.toObject(hash);
    });
  }

  hashN(inputs: bigint[], useCache: boolean = false): bigint {
    this.ensureInitialized();
    
    if (inputs.length === 0) {
      throw new Error('Cannot hash empty array');
    }
    
    inputs.forEach(input => this.validateFieldElement(input));
    
    const hash = this.poseidon(inputs);
    this.stats.totalHashes++;
    return this.poseidon.F.toObject(hash);
  }

  batchHash(inputs: bigint[]): BatchHashResult {
    this.ensureInitialized();
    
    const startTime = performance.now();
    const hashes: bigint[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    
    for (const input of inputs) {
      const cacheKey = `h1:${input.toString()}`;
      const cached = this.hashCache.get(cacheKey);
      
      if (cached) {
        hashes.push(cached.hash);
        cacheHits++;
      } else {
        const hash = this.hash(input, true);
        hashes.push(hash);
        cacheMisses++;
      }
    }
    
    this.stats.batchOperations++;
    
    return {
      hashes,
      processingTime: performance.now() - startTime,
      cacheHits,
      cacheMisses
    };
  }

  toFelt252(value: bigint): string {
    this.validateFieldElement(value);
    return '0x' + value.toString(16).padStart(64, '0');
  }

  fromFelt252(felt: string): bigint {
    const normalized = felt.startsWith('0x') ? felt.slice(2) : felt;
    const value = BigInt('0x' + normalized);
    this.validateFieldElement(value);
    return value;
  }

  randomFieldElement(): bigint {
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(31);
    return BigInt('0x' + bytes.toString('hex'));
  }

  createCommitment(amount: bigint, recipient: bigint, secret: bigint): bigint {
    return this.hash3([amount, recipient, secret]);
  }

  createNullifier(secret: bigint, recipient: bigint): bigint {
    return this.hash2([secret, recipient]);
  }

  createAmountCommitment(amount: bigint, secret: bigint): bigint {
    return this.hash2([amount, secret]);
  }

  verifyCommitment(commitment: bigint, amount: bigint, recipient: bigint, secret: bigint): boolean {
    const expectedCommitment = this.createCommitment(amount, recipient, secret);
    return commitment === expectedCommitment;
  }

  verifyNullifier(nullifier: bigint, secret: bigint, recipient: bigint): boolean {
    const expectedNullifier = this.createNullifier(secret, recipient);
    return nullifier === expectedNullifier;
  }

  getFieldPrime(): bigint {
    return this.fieldPrime;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getMetrics(): PerformanceMetrics {
    const cacheHitRate = this.stats.totalHashes > 0 
      ? (this.stats.cacheHits / this.stats.totalHashes) * 100 
      : 0;
    
    return {
      ...this.stats,
      cacheHitRate
    };
  }

  clearCache(): void {
    this.hashCache.clear();
    console.log('✅ Hash cache cleared');
  }

  getCacheSize(): number {
    return this.hashCache.size;
  }
}
