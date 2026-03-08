/**
 * SecureKeyManager - Production AES-256-GCM + Argon2id
 * Key rotation, audit logging, HKDF derivation, secure wipe
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import argon2 from 'argon2';
import { EventEmitter } from 'events';

export interface EncOpts {
  algorithm?: string;
  keyLength?: number;
  argon2MemCost?: number;
  argon2TimeCost?: number;
  argon2Parallelism?: number;
  auditLogPath?: string;
  keyRotationDays?: number;
  backupPath?: string;
}

interface KeyMeta { version: number; createdAt: number; rotatedAt: number; purpose: string; }
interface AuditEntry { ts: number; op: string; purpose: string; ok: boolean; err?: string; }

export class SecureKeyManager extends EventEmitter {
  private masterKey!: Buffer;
  private salt!: Buffer;
  private derivedKeys = new Map<string, Buffer>();
  private keyMeta = new Map<string, KeyMeta>();
  private keyVersion = 1;
  private destroyed = false;
  private readonly algo: string;
  private readonly keyLen: number;
  private readonly auditPath: string;
  private readonly backupPath: string;
  private readonly rotationDays: number;
  private readonly argon2Opts: { memoryCost: number; timeCost: number; parallelism: number };

  constructor(masterPassword: string, saltPath = './secure/salt.bin', opts: EncOpts = {}) {
    super();
    if (!masterPassword || masterPassword.length < 16)
      throw new Error('Master password must be ≥ 16 characters');

    this.algo = opts.algorithm ?? 'aes-256-gcm';
    this.keyLen = opts.keyLength ?? 32;
    this.auditPath = opts.auditLogPath ?? './secure/audit.log';
    this.backupPath = opts.backupPath ?? './secure/backups';
    this.rotationDays = opts.keyRotationDays ?? 90;
    this.argon2Opts = {
      memoryCost: opts.argon2MemCost ?? 65536,
      timeCost: opts.argon2TimeCost ?? 3,
      parallelism: opts.argon2Parallelism ?? 4,
    };

    [path.dirname(this.auditPath), this.backupPath].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    });

    if (fs.existsSync(saltPath)) {
      this.salt = fs.readFileSync(saltPath);
      if (this.salt.length !== 32) throw new Error('Corrupted salt file');
    } else {
      this.salt = crypto.randomBytes(32);
      const dir = path.dirname(saltPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(saltPath, this.salt, { mode: 0o600 });
      fs.writeFileSync(path.join(this.backupPath, `salt_${Date.now()}.bin`), this.salt, { mode: 0o600 });
    }

    this._deriveMasterKey(masterPassword);
    this._loadMeta();
    this._checkRotation();
    this._audit('INIT', 'system', true);
  }

  private _deriveMasterKey(pass: string) {
    // Synchronous PBKDF2 for constructor; call initializeAsync() immediately after to upgrade to Argon2id
    this.masterKey = crypto.pbkdf2Sync(pass, this.salt, 600_000, this.keyLen, 'sha512');
  }

  async initializeAsync(pass: string): Promise<void> {
    const hash = await argon2.hash(pass, {
      type: argon2.argon2id,
      memoryCost: this.argon2Opts.memoryCost,
      timeCost: this.argon2Opts.timeCost,
      parallelism: this.argon2Opts.parallelism,
      hashLength: this.keyLen,
      salt: this.salt,
      raw: true,
    });
    this.masterKey.fill(0);
    this.masterKey = Buffer.from(hash);
    this.derivedKeys.clear(); // Re-derive all keys with stronger master
  }

  private _loadMeta() {
    const p = path.join(path.dirname(this.auditPath), 'key_meta.json');
    if (!fs.existsSync(p)) return;
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      this.keyVersion = d.version ?? 1;
      for (const [k, v] of Object.entries(d.keys ?? {})) this.keyMeta.set(k, v as KeyMeta);
    } catch { /* use defaults */ }
  }

  private _saveMeta() {
    const p = path.join(path.dirname(this.auditPath), 'key_meta.json');
    fs.writeFileSync(p, JSON.stringify({ version: this.keyVersion, keys: Object.fromEntries(this.keyMeta) }, null, 2), { mode: 0o600 });
  }

  private _checkRotation() {
    const threshold = this.rotationDays * 86_400_000;
    for (const [purpose, meta] of this.keyMeta) {
      if (Date.now() - meta.rotatedAt > threshold) this.emit('key-rotation-needed', { purpose, meta });
    }
  }

  private _audit(op: string, purpose: string, ok: boolean, err?: string) {
    const entry: AuditEntry = { ts: Date.now(), op, purpose, ok, ...(err ? { err } : {}) };
    try { fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch { /* non-fatal */ }
  }

  private _assert() { if (this.destroyed) throw new Error('SecureKeyManager destroyed'); }

  deriveKey(purpose: string, version?: number): Buffer {
    this._assert();
    const ver = version ?? this.keyVersion;
    const ck = `${purpose}:v${ver}`;
    if (!this.derivedKeys.has(ck)) {
      const info = Buffer.from(`${purpose}:v${ver}`, 'utf8');
      const prk = crypto.createHmac('sha512', this.masterKey).update(this.salt).digest();
      const okm = crypto.createHmac('sha512', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest().subarray(0, this.keyLen);
      this.derivedKeys.set(ck, okm);
      if (!this.keyMeta.has(purpose)) {
        this.keyMeta.set(purpose, { version: ver, createdAt: Date.now(), rotatedAt: Date.now(), purpose });
        this._saveMeta();
      }
      this._audit('DERIVE_KEY', purpose, true);
    }
    return this.derivedKeys.get(ck)!;
  }

  encrypt(data: string, purpose = 'default', aad?: string): string {
    this._assert();
    try {
      const key = this.deriveKey(purpose);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algo as any, key, iv) as crypto.CipherGCM;
      if (aad) cipher.setAAD(Buffer.from(aad));
      let enc = cipher.update(data, 'utf8', 'hex') + cipher.final('hex');
      const tag = cipher.getAuthTag();
      const ver = this.keyMeta.get(purpose)?.version ?? this.keyVersion;
      let result = `${ver}:${iv.toString('hex')}:${tag.toString('hex')}:${enc}`;
      if (aad) result += `:${Buffer.from(aad).toString('hex')}`;
      this._audit('ENCRYPT', purpose, true);
      return result;
    } catch (e: any) { this._audit('ENCRYPT', purpose, false, e.message); throw e; }
  }

  decrypt(data: string, purpose = 'default', aad?: string): string {
    this._assert();
    try {
      const parts = data.split(':');
      if (parts.length < 4) throw new Error('Invalid ciphertext format');
      const [verStr, ivHex, tagHex, enc, ...rest] = parts;
      const encFull = enc + (rest.length > 1 ? ':' + rest.slice(0, -1).join(':') : '');
      const storedAad = rest.length ? Buffer.from(rest[rest.length - 1], 'hex').toString('utf8') : undefined;
      const finalAad = aad ?? storedAad;
      const key = this.deriveKey(purpose, parseInt(verStr));
      const decipher = crypto.createDecipheriv(this.algo as any, key, Buffer.from(ivHex, 'hex')) as crypto.DecipherGCM;
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      if (finalAad) decipher.setAAD(Buffer.from(finalAad));
      const result = decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
      this._audit('DECRYPT', purpose, true);
      return result;
    } catch (e: any) { this._audit('DECRYPT', purpose, false, e.message); throw e; }
  }

  encryptPrivateKey(pk: string, keyId?: string): string {
    if (!pk || pk.length < 32) throw new Error('Invalid private key');
    const aad = keyId ?? crypto.randomBytes(16).toString('hex');
    return this.encrypt(pk, 'private_keys', aad);
  }

  decryptPrivateKey(enc: string, keyId?: string): string { return this.decrypt(enc, 'private_keys', keyId); }

  getSecureEnv(key: string): string {
    this._assert();
    const val = process.env[key];
    if (!val) throw new Error(`Missing env var: ${key}`);
    try { return this.decrypt(val, 'env_vars'); } catch { return val; }
  }

  hmac(data: string, purpose = 'default'): string {
    return crypto.createHmac('sha512', this.deriveKey(purpose)).update(data).digest('hex');
  }

  verifyHmac(data: string, provided: string, purpose = 'default'): boolean {
    const expected = Buffer.from(this.hmac(data, purpose), 'hex');
    const given = Buffer.from(provided, 'hex');
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
  }

  randomBytes(n: number): Buffer { this._assert(); return crypto.randomBytes(n); }
  randomHex(n: number): string { return this.randomBytes(n).toString('hex'); }
  generateSecureToken(n = 32): string { return crypto.randomBytes(n).toString('base64url'); }

  rotateKey(purpose: string): void {
    this._assert();
    const meta = this.keyMeta.get(purpose);
    if (!meta) throw new Error(`No key found for: ${purpose}`);
    const oldCk = `${purpose}:v${meta.version}`;
    const old = this.derivedKeys.get(oldCk);
    if (old) { old.fill(0); this.derivedKeys.delete(oldCk); }
    meta.version++;
    meta.rotatedAt = Date.now();
    this._saveMeta();
    this.deriveKey(purpose, meta.version);
    this._audit('ROTATE_KEY', purpose, true);
    this.emit('key-rotated', { purpose, version: meta.version });
  }

  getAuditLog(limit = 100): AuditEntry[] {
    if (!fs.existsSync(this.auditPath)) return [];
    return fs.readFileSync(this.auditPath, 'utf8').trim().split('\n').slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  destroy(): void {
    if (this.destroyed) return;
    this._audit('DESTROY', 'system', true);
    this.masterKey?.fill(0);
    this.salt?.fill(0);
    for (const k of this.derivedKeys.values()) k.fill(0);
    this.derivedKeys.clear();
    this.keyMeta.clear();
    this.destroyed = true;
    this.removeAllListeners();
  }
}

/**
 * EnvironmentEncryptor - encrypt/decrypt .env files at rest
 */
export class EnvironmentEncryptor {
  private km: SecureKeyManager;
  private sensitive = [/PRIVATE[_-]?KEY/i,/SECRET/i,/PASSWORD/i,/TOKEN/i,/API[_-]?KEY/i,/MASTER/i,/RELAYER/i,/MNEMONIC/i,/SEED/i,/RPC[_-]?PASS/i];

  constructor(pass: string) { this.km = new SecureKeyManager(pass); }

  encryptEnvFile(input: string, output: string): void {
    const lines = fs.readFileSync(input, 'utf8').split('\n').map(line => {
      if (!line.trim() || line.trim().startsWith('#')) return line;
      const m = line.match(/^([^=]+)=(.*)$/);
      if (!m) return line;
      const [, key, val] = m;
      if (this.sensitive.some(r => r.test(key.trim())) && !this._isEncrypted(val)) {
        return `${key.trim()}=${this.km.encrypt(val, 'env_vars')}`;
      }
      return line;
    });
    fs.writeFileSync(output, lines.join('\n'), { mode: 0o600 });
  }

  decryptEnvFile(input: string, output: string): void {
    const lines = fs.readFileSync(input, 'utf8').split('\n').map(line => {
      if (!line.trim() || line.trim().startsWith('#')) return line;
      const m = line.match(/^([^=]+)=(.*)$/);
      if (!m) return line;
      const [, key, val] = m;
      if (this._isEncrypted(val)) return `${key.trim()}=${this.km.decrypt(val, 'env_vars')}`;
      return line;
    });
    fs.writeFileSync(output, lines.join('\n'), { mode: 0o600 });
  }

  private _isEncrypted(v: string): boolean {
    const parts = v.split(':');
    return parts.length >= 4 && /^\d+$/.test(parts[0]) && /^[0-9a-f]+$/i.test(parts[1]);
  }

  destroy() { this.km.destroy(); }
}
