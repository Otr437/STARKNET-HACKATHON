/**
 * Poseidon Hasher - Production
 * BN254 field, caching, metrics, batch operations
 */
import { buildPoseidon } from 'circomlibjs';

export class PoseidonHasher {
  private poseidon: any;
  private initialized = false;
  private readonly FIELD = BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001');
  private cache = new Map<string, { hash: bigint; hits: number; ts: number }>();
  private stats = { total: 0, hits: 0, misses: 0, batchOps: 0 };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const t = Date.now();
    this.poseidon = await buildPoseidon();
    this.initialized = true;
    setInterval(() => this._evictCache(), 300_000);
    console.log(`[Poseidon] ready in ${Date.now() - t}ms`);
  }

  private _evictCache() {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.ts > 3_600_000 || this.cache.size > 10_000) this.cache.delete(k);
    }
  }

  private _ensure() {
    if (!this.initialized) throw new Error('PoseidonHasher: call initialize() first');
  }

  private _validate(v: bigint) {
    if (v < 0n || v >= this.FIELD) throw new RangeError(`Field element out of range: ${v}`);
  }

  private _compute(key: string, inputs: bigint[]): bigint {
    const cached = this.cache.get(key);
    if (cached) { cached.hits++; cached.ts = Date.now(); this.stats.hits++; return cached.hash; }
    const raw = this.poseidon(inputs);
    const hash = this.poseidon.F.toObject(raw);
    this.cache.set(key, { hash, hits: 1, ts: Date.now() });
    this.stats.misses++;
    this.stats.total++;
    return hash;
  }

  hash(a: bigint): bigint { this._ensure(); this._validate(a); return this._compute(`h1:${a}`, [a]); }
  hash2(a: bigint, b: bigint): bigint { this._ensure(); [a,b].forEach(v=>this._validate(v)); return this._compute(`h2:${a}:${b}`, [a,b]); }
  hash3(a: bigint, b: bigint, c: bigint): bigint { this._ensure(); [a,b,c].forEach(v=>this._validate(v)); return this._compute(`h3:${a}:${b}:${c}`, [a,b,c]); }
  hash4(a: bigint, b: bigint, c: bigint, d: bigint): bigint { this._ensure(); [a,b,c,d].forEach(v=>this._validate(v)); return this._compute(`h4:${a}:${b}:${c}:${d}`, [a,b,c,d]); }

  createCommitment(amount: bigint, recipient: bigint, secret: bigint): bigint { return this.hash3(amount, recipient, secret); }
  createNullifier(secret: bigint, recipient: bigint): bigint { return this.hash2(secret, recipient); }
  createAmountCommitment(amount: bigint, secret: bigint): bigint { return this.hash2(amount, secret); }

  verifyCommitment(commitment: bigint, amount: bigint, recipient: bigint, secret: bigint): boolean {
    return commitment === this.createCommitment(amount, recipient, secret);
  }
  verifyNullifier(nullifier: bigint, secret: bigint, recipient: bigint): boolean {
    return nullifier === this.createNullifier(secret, recipient);
  }

  toFelt252(v: bigint): string { this._validate(v); return '0x' + v.toString(16).padStart(64, '0'); }
  fromFelt252(s: string): bigint {
    const v = BigInt(s.startsWith('0x') ? s : '0x' + s);
    this._validate(v); return v;
  }

  randomFieldElement(): bigint {
    const { randomBytes } = require('crypto');
    return BigInt('0x' + randomBytes(31).toString('hex'));
  }

  getMetrics() {
    return { ...this.stats, hitRate: this.stats.total ? this.stats.hits / this.stats.total : 0, cacheSize: this.cache.size };
  }
  clearCache() { this.cache.clear(); }
}
