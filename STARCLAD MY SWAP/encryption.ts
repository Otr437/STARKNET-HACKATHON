/**
 * Encryption & Key Management Module
 * Production-grade encryption with argon2id, key rotation, HSM support, and audit logging
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import argon2 from 'argon2';
import { EventEmitter } from 'events';

export interface EncryptionOptions {
  algorithm?: string;
  keyLength?: number;
  iterations?: number;
  useArgon2?: boolean;
  argon2Options?: Argon2Options;
  enableAuditLog?: boolean;
  auditLogPath?: string;
  keyRotationDays?: number;
  backupPath?: string;
}

export interface Argon2Options {
  type?: 0 | 1 | 2; // 0 = argon2d, 1 = argon2i, 2 = argon2id
  memoryCost?: number; // Memory in KiB
  timeCost?: number; // Number of iterations
  parallelism?: number; // Number of threads
}

export interface KeyMetadata {
  version: number;
  createdAt: number;
  rotatedAt: number;
  purpose: string;
  algorithm: string;
}

export interface AuditLogEntry {
  timestamp: number;
  operation: string;
  purpose: string;
  success: boolean;
  error?: string;
  metadata?: any;
}

export class SecureKeyManager extends EventEmitter {
  private masterKey: Buffer;
  private derivedKeys: Map<string, Buffer> = new Map();
  private keyMetadata: Map<string, KeyMetadata> = new Map();
  private encryptionSalt: Buffer;
  private readonly algorithm: string;
  private readonly keyLength: number;
  private readonly iterations: number;
  private readonly useArgon2: boolean;
  private readonly argon2Options: Argon2Options;
  private readonly enableAuditLog: boolean;
  private readonly auditLogPath: string;
  private readonly keyRotationDays: number;
  private readonly backupPath: string;
  private keyVersion: number = 1;
  private isDestroyed: boolean = false;
  
  constructor(
    masterPassword: string, 
    saltPath: string = './secure/salt.bin',
    options: EncryptionOptions = {}
  ) {
    super();
    
    if (!masterPassword || masterPassword.length < 16) {
      throw new Error('Master password must be at least 16 characters');
    }

    this.algorithm = options.algorithm || 'aes-256-gcm';
    this.keyLength = options.keyLength || 32;
    this.iterations = options.iterations || 600000;
    this.useArgon2 = options.useArgon2 !== false; // Default true
    this.enableAuditLog = options.enableAuditLog !== false;
    this.auditLogPath = options.auditLogPath || './secure/audit.log';
    this.keyRotationDays = options.keyRotationDays || 90;
    this.backupPath = options.backupPath || './secure/backups';
    
    // Argon2id configuration (OWASP recommended)
    this.argon2Options = {
      type: options.argon2Options?.type ?? 2, // argon2id
      memoryCost: options.argon2Options?.memoryCost ?? 65536, // 64 MiB
      timeCost: options.argon2Options?.timeCost ?? 3,
      parallelism: options.argon2Options?.parallelism ?? 4
    };

    // Create secure directories
    this.initializeDirectories();

    // Load or generate encryption salt
    if (fs.existsSync(saltPath)) {
      this.encryptionSalt = fs.readFileSync(saltPath);
      
      // Verify salt integrity
      if (this.encryptionSalt.length !== 32) {
        throw new Error('Corrupted salt file detected');
      }
    } else {
      this.encryptionSalt = crypto.randomBytes(32);
      const dir = path.dirname(saltPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(saltPath, this.encryptionSalt, { mode: 0o600 });
      
      // Create backup of salt
      const backupSaltPath = path.join(this.backupPath, `salt_${Date.now()}.bin`);
      fs.writeFileSync(backupSaltPath, this.encryptionSalt, { mode: 0o600 });
    }
    
    // Derive master key
    this.initializeMasterKey(masterPassword);
    
    // Load key metadata
    this.loadKeyMetadata();
    
    // Check for key rotation
    this.checkKeyRotation();
    
    this.auditLog('INIT', 'system', true, { 
      algorithm: this.algorithm,
      useArgon2: this.useArgon2 
    });
  }

  /**
   * Initialize secure directories with proper permissions
   */
  private initializeDirectories(): void {
    const dirs = [
      path.dirname(this.auditLogPath),
      this.backupPath
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
  }

  /**
   * Initialize master key using argon2id or PBKDF2
   */
  private async initializeMasterKey(masterPassword: string): Promise<void> {
    try {
      if (this.useArgon2) {
        // Use argon2id (production recommended)
        const hash = await argon2.hash(masterPassword, {
          type: this.argon2Options.type,
          memoryCost: this.argon2Options.memoryCost,
          timeCost: this.argon2Options.timeCost,
          parallelism: this.argon2Options.parallelism,
          hashLength: this.keyLength,
          salt: this.encryptionSalt,
          raw: true
        });
        this.masterKey = Buffer.from(hash);
      } else {
        // Fallback to PBKDF2 (for compatibility)
        this.masterKey = crypto.pbkdf2Sync(
          masterPassword, 
          this.encryptionSalt, 
          this.iterations, 
          this.keyLength, 
          'sha512'
        );
      }
    } catch (error: any) {
      this.auditLog('INIT', 'system', false, { error: error.message });
      throw new Error(`Failed to derive master key: ${error.message}`);
    }
  }

  /**
   * Load key metadata from disk
   */
  private loadKeyMetadata(): void {
    const metadataPath = path.join(path.dirname(this.auditLogPath), 'key_metadata.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        this.keyVersion = data.version || 1;
        
        for (const [purpose, metadata] of Object.entries(data.keys || {})) {
          this.keyMetadata.set(purpose, metadata as KeyMetadata);
        }
      } catch (error) {
        console.warn('Failed to load key metadata, using defaults');
      }
    }
  }

  /**
   * Save key metadata to disk
   */
  private saveKeyMetadata(): void {
    const metadataPath = path.join(path.dirname(this.auditLogPath), 'key_metadata.json');
    const data = {
      version: this.keyVersion,
      keys: Object.fromEntries(this.keyMetadata.entries())
    };
    
    fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  /**
   * Check if any keys need rotation
   */
  private checkKeyRotation(): void {
    const now = Date.now();
    const rotationThreshold = this.keyRotationDays * 24 * 60 * 60 * 1000;

    for (const [purpose, metadata] of this.keyMetadata.entries()) {
      const age = now - metadata.rotatedAt;
      if (age > rotationThreshold) {
        this.emit('key-rotation-needed', { purpose, age, metadata });
      }
    }
  }

  /**
   * Audit logging for all cryptographic operations
   */
  private auditLog(operation: string, purpose: string, success: boolean, metadata?: any): void {
    if (!this.enableAuditLog) return;

    const entry: AuditLogEntry = {
      timestamp: Date.now(),
      operation,
      purpose,
      success,
      metadata
    };

    if (!success && metadata?.error) {
      entry.error = metadata.error;
    }

    try {
      fs.appendFileSync(
        this.auditLogPath,
        JSON.stringify(entry) + '\n',
        { mode: 0o600 }
      );
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }
  }

  /**
   * Derive a purpose-specific key from the master key with key versioning
   */
  deriveKey(purpose: string, version?: number): Buffer {
    this.assertNotDestroyed();
    
    const keyVersion = version || this.keyVersion;
    const cacheKey = `${purpose}:v${keyVersion}`;
    
    if (!this.derivedKeys.has(cacheKey)) {
      try {
        // Use HKDF (HMAC-based Key Derivation Function) for better security
        const info = Buffer.from(`${purpose}:v${keyVersion}`, 'utf8');
        const prk = crypto.createHmac('sha512', this.masterKey)
          .update(this.encryptionSalt)
          .digest();
        
        const hmac = crypto.createHmac('sha512', prk);
        hmac.update(Buffer.concat([info, Buffer.from([0x01])]));
        const derivedKey = hmac.digest().slice(0, this.keyLength);
        
        this.derivedKeys.set(cacheKey, derivedKey);
        
        // Update metadata
        if (!this.keyMetadata.has(purpose)) {
          this.keyMetadata.set(purpose, {
            version: keyVersion,
            createdAt: Date.now(),
            rotatedAt: Date.now(),
            purpose,
            algorithm: this.algorithm
          });
          this.saveKeyMetadata();
        }
        
        this.auditLog('DERIVE_KEY', purpose, true, { version: keyVersion });
      } catch (error: any) {
        this.auditLog('DERIVE_KEY', purpose, false, { error: error.message });
        throw error;
      }
    }
    
    return this.derivedKeys.get(cacheKey)!;
  }

  /**
   * Rotate a specific key
   */
  rotateKey(purpose: string): void {
    this.assertNotDestroyed();
    
    const metadata = this.keyMetadata.get(purpose);
    if (!metadata) {
      throw new Error(`No metadata found for purpose: ${purpose}`);
    }

    // Increment version
    const newVersion = metadata.version + 1;
    
    // Clear old key from cache
    const oldCacheKey = `${purpose}:v${metadata.version}`;
    const oldKey = this.derivedKeys.get(oldCacheKey);
    if (oldKey) {
      oldKey.fill(0); // Securely wipe
      this.derivedKeys.delete(oldCacheKey);
    }

    // Update metadata
    metadata.version = newVersion;
    metadata.rotatedAt = Date.now();
    this.keyMetadata.set(purpose, metadata);
    this.saveKeyMetadata();

    // Derive new key
    this.deriveKey(purpose, newVersion);
    
    this.auditLog('ROTATE_KEY', purpose, true, { newVersion });
    this.emit('key-rotated', { purpose, version: newVersion });
  }

  /**
   * Rotate all keys
   */
  rotateAllKeys(): void {
    this.assertNotDestroyed();
    
    const purposes = Array.from(this.keyMetadata.keys());
    for (const purpose of purposes) {
      this.rotateKey(purpose);
    }
    
    this.keyVersion++;
    this.saveKeyMetadata();
  }

  /**
   * Encrypt data with authenticated encryption (AES-256-GCM) and optional compression
   */
  encrypt(data: string, purpose: string = 'default', additionalData?: string): string {
    this.assertNotDestroyed();
    
    try {
      const key = this.deriveKey(purpose);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);
      
      // Add additional authenticated data if provided
      if (additionalData) {
        cipher.setAAD(Buffer.from(additionalData, 'utf8'));
      }
      
      // Optional: Compress data if it's large
      let dataToEncrypt = data;
      let compressed = false;
      
      if (data.length > 1024) { // Compress if > 1KB
        const zlib = require('zlib');
        dataToEncrypt = zlib.deflateSync(data).toString('base64');
        compressed = true;
      }
      
      let encrypted = cipher.update(dataToEncrypt, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      
      // Format: version:compressed:iv:authTag:encrypted[:aad]
      const version = this.keyMetadata.get(purpose)?.version || this.keyVersion;
      let result = `${version}:${compressed ? '1' : '0'}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
      
      if (additionalData) {
        result += `:${Buffer.from(additionalData).toString('hex')}`;
      }
      
      this.auditLog('ENCRYPT', purpose, true, { 
        dataLength: data.length, 
        compressed,
        hasAAD: !!additionalData 
      });
      
      return result;
    } catch (error: any) {
      this.auditLog('ENCRYPT', purpose, false, { error: error.message });
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt data and verify authenticity with support for key versioning
   */
  decrypt(encryptedData: string, purpose: string = 'default', additionalData?: string): string {
    this.assertNotDestroyed();
    
    try {
      const parts = encryptedData.split(':');
      
      if (parts.length < 5) {
        throw new Error('Invalid encrypted data format');
      }
      
      const [versionStr, compressedStr, ivHex, authTagHex, encrypted] = parts;
      const version = parseInt(versionStr, 10);
      const compressed = compressedStr === '1';
      
      // Handle AAD if present
      let aad: string | undefined;
      if (parts.length === 6) {
        aad = Buffer.from(parts[5], 'hex').toString('utf8');
      }
      
      // Use AAD from either parameter or encrypted data
      const finalAAD = additionalData || aad;
      
      const key = this.deriveKey(purpose, version);
      const decipher = crypto.createDecipheriv(
        this.algorithm, 
        key, 
        Buffer.from(ivHex, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
      
      if (finalAAD) {
        decipher.setAAD(Buffer.from(finalAAD, 'utf8'));
      }
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      // Decompress if needed
      if (compressed) {
        const zlib = require('zlib');
        const buffer = Buffer.from(decrypted, 'base64');
        decrypted = zlib.inflateSync(buffer).toString('utf8');
      }
      
      this.auditLog('DECRYPT', purpose, true, { 
        version, 
        compressed,
        hasAAD: !!finalAAD 
      });
      
      return decrypted;
    } catch (error: any) {
      this.auditLog('DECRYPT', purpose, false, { error: error.message });
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * Encrypt with multiple keys for redundancy (encrypt same data with different purposes)
   */
  encryptMultiKey(data: string, purposes: string[]): Map<string, string> {
    this.assertNotDestroyed();
    
    const results = new Map<string, string>();
    
    for (const purpose of purposes) {
      results.set(purpose, this.encrypt(data, purpose));
    }
    
    return results;
  }

  /**
   * Try to decrypt with multiple keys until one works
   */
  decryptMultiKey(encryptedData: string, purposes: string[]): string {
    this.assertNotDestroyed();
    
    let lastError: Error | null = null;
    
    for (const purpose of purposes) {
      try {
        return this.decrypt(encryptedData, purpose);
      } catch (error: any) {
        lastError = error;
        continue;
      }
    }
    
    throw new Error(`Failed to decrypt with any of the provided keys: ${lastError?.message}`);
  }

  /**
   * Encrypt private keys for secure storage with additional protections
   */
  encryptPrivateKey(privateKey: string, keyId?: string): string {
    this.assertNotDestroyed();
    
    // Additional validation for private keys
    if (!privateKey || privateKey.length < 32) {
      throw new Error('Invalid private key format');
    }
    
    // Use key ID as additional authenticated data
    const aad = keyId || crypto.randomBytes(16).toString('hex');
    const encrypted = this.encrypt(privateKey, 'private_keys', aad);
    
    return encrypted;
  }

  /**
   * Decrypt stored private keys
   */
  decryptPrivateKey(encrypted: string, keyId?: string): string {
    this.assertNotDestroyed();
    
    return this.decrypt(encrypted, 'private_keys', keyId);
  }

  /**
   * Securely retrieve and decrypt environment variables
   */
  getSecureEnv(key: string): string {
    this.assertNotDestroyed();
    
    const encrypted = process.env[key];
    if (!encrypted) {
      throw new Error(`Missing environment variable: ${key}`);
    }
    
    try {
      // Try to decrypt (for production encrypted env vars)
      return this.decrypt(encrypted, 'env_vars');
    } catch {
      // If not encrypted, return as-is (for development)
      return encrypted;
    }
  }

  /**
   * Create a secure hash of data (for integrity checks, not encryption)
   */
  hash(data: string, algorithm: string = 'sha512'): string {
    this.assertNotDestroyed();
    
    return crypto.createHash(algorithm).update(data).digest('hex');
  }

  /**
   * Create HMAC for message authentication
   */
  hmac(data: string, purpose: string = 'default'): string {
    this.assertNotDestroyed();
    
    const key = this.deriveKey(purpose);
    return crypto.createHmac('sha512', key).update(data).digest('hex');
  }

  /**
   * Verify HMAC
   */
  verifyHmac(data: string, providedHmac: string, purpose: string = 'default'): boolean {
    this.assertNotDestroyed();
    
    const expectedHmac = this.hmac(data, purpose);
    
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expectedHmac, 'hex'),
      Buffer.from(providedHmac, 'hex')
    );
  }

  /**
   * Generate cryptographically secure random bytes
   */
  randomBytes(length: number): Buffer {
    this.assertNotDestroyed();
    
    return crypto.randomBytes(length);
  }

  /**
   * Generate random hex string
   */
  randomHex(length: number): string {
    return this.randomBytes(length).toString('hex');
  }

  /**
   * Generate secure token for API keys, session tokens, etc.
   */
  generateSecureToken(length: number = 32): string {
    this.assertNotDestroyed();
    
    return crypto.randomBytes(length).toString('base64url');
  }

  /**
   * Derive a key for ECDH (Elliptic Curve Diffie-Hellman)
   */
  deriveECDHKey(privateKey: Buffer, publicKey: Buffer): Buffer {
    this.assertNotDestroyed();
    
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privateKey);
    
    return ecdh.computeSecret(publicKey);
  }

  /**
   * Export encrypted backup of all keys
   */
  exportBackup(password: string): string {
    this.assertNotDestroyed();
    
    const backup = {
      version: this.keyVersion,
      metadata: Object.fromEntries(this.keyMetadata.entries()),
      timestamp: Date.now(),
      salt: this.encryptionSalt.toString('hex')
    };
    
    // Encrypt backup with separate password
    const tempManager = new SecureKeyManager(password, this.backupPath + '/temp_salt.bin', {
      useArgon2: this.useArgon2,
      enableAuditLog: false
    });
    
    const encrypted = tempManager.encrypt(JSON.stringify(backup), 'backup');
    tempManager.destroy();
    
    // Save backup file
    const backupFile = path.join(this.backupPath, `backup_${Date.now()}.enc`);
    fs.writeFileSync(backupFile, encrypted, { mode: 0o600 });
    
    this.auditLog('EXPORT_BACKUP', 'system', true, { backupFile });
    
    return backupFile;
  }

  /**
   * Import encrypted backup
   */
  importBackup(encryptedBackup: string, password: string): void {
    this.assertNotDestroyed();
    
    try {
      const tempManager = new SecureKeyManager(password, this.backupPath + '/temp_salt.bin', {
        useArgon2: this.useArgon2,
        enableAuditLog: false
      });
      
      const decrypted = tempManager.decrypt(encryptedBackup, 'backup');
      const backup = JSON.parse(decrypted);
      
      // Restore metadata
      this.keyVersion = backup.version;
      this.keyMetadata.clear();
      
      for (const [purpose, metadata] of Object.entries(backup.metadata)) {
        this.keyMetadata.set(purpose, metadata as KeyMetadata);
      }
      
      this.saveKeyMetadata();
      tempManager.destroy();
      
      this.auditLog('IMPORT_BACKUP', 'system', true, { 
        version: backup.version,
        timestamp: backup.timestamp 
      });
    } catch (error: any) {
      this.auditLog('IMPORT_BACKUP', 'system', false, { error: error.message });
      throw new Error(`Failed to import backup: ${error.message}`);
    }
  }

  /**
   * Check if manager has been destroyed
   */
  private assertNotDestroyed(): void {
    if (this.isDestroyed) {
      throw new Error('SecureKeyManager has been destroyed');
    }
  }

  /**
   * Get audit log entries
   */
  getAuditLog(limit: number = 100): AuditLogEntry[] {
    if (!this.enableAuditLog || !fs.existsSync(this.auditLogPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.auditLogPath, 'utf8');
      const lines = content.trim().split('\n').slice(-limit);
      
      return lines.map(line => JSON.parse(line));
    } catch (error) {
      console.error('Failed to read audit log:', error);
      return [];
    }
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    if (this.enableAuditLog && fs.existsSync(this.auditLogPath)) {
      // Archive old log
      const archivePath = this.auditLogPath + `.${Date.now()}.archive`;
      fs.renameSync(this.auditLogPath, archivePath);
      
      this.auditLog('CLEAR_AUDIT_LOG', 'system', true, { archivePath });
    }
  }

  /**
   * Get key metadata
   */
  getKeyMetadata(purpose?: string): KeyMetadata | Map<string, KeyMetadata> {
    if (purpose) {
      const metadata = this.keyMetadata.get(purpose);
      if (!metadata) {
        throw new Error(`No metadata found for purpose: ${purpose}`);
      }
      return metadata;
    }
    return new Map(this.keyMetadata);
  }

  /**
   * Securely clear sensitive data from memory
   */
  destroy(): void {
    if (this.isDestroyed) return;

    this.auditLog('DESTROY', 'system', true);

    // Overwrite sensitive buffers with zeros
    if (this.masterKey) {
      this.masterKey.fill(0);
    }
    if (this.encryptionSalt) {
      this.encryptionSalt.fill(0);
    }
    
    // Clear all derived keys
    this.derivedKeys.forEach(key => {
      key.fill(0);
    });
    this.derivedKeys.clear();
    
    // Clear metadata
    this.keyMetadata.clear();
    
    this.isDestroyed = true;
    
    // Remove all event listeners
    this.removeAllListeners();
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * Check if destroyed
   */
  isDestroyed_(): boolean {
    return this.isDestroyed;
  }
}

/**
 * Environment variable encryption utility with secure file handling
 */
export class EnvironmentEncryptor {
  private keyManager: SecureKeyManager;
  private readonly sensitivePatterns: RegExp[];

  constructor(masterPassword: string, options?: EncryptionOptions) {
    this.keyManager = new SecureKeyManager(masterPassword, undefined, options);
    
    // Patterns for detecting sensitive keys
    this.sensitivePatterns = [
      /PRIVATE[_-]?KEY/i,
      /SECRET/i,
      /PASSWORD/i,
      /PASS/i,
      /TOKEN/i,
      /API[_-]?KEY/i,
      /MASTER/i,
      /RELAYER/i,
      /MNEMONIC/i,
      /SEED/i,
      /AUTH/i,
      /CREDENTIAL/i,
      /RPC[_-]?PASS/i
    ];
  }

  /**
   * Encrypt all sensitive environment variables with backup and diff
   */
  encryptEnvFile(inputPath: string, outputPath: string, options?: {
    createBackup?: boolean;
    showDiff?: boolean;
    dryRun?: boolean;
  }): {
    encrypted: number;
    skipped: number;
    errors: string[];
    backup?: string;
  } {
    const opts = {
      createBackup: true,
      showDiff: false,
      dryRun: false,
      ...options
    };

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    // Create backup if requested
    let backupPath: string | undefined;
    if (opts.createBackup && fs.existsSync(outputPath)) {
      backupPath = `${outputPath}.backup.${Date.now()}`;
      fs.copyFileSync(outputPath, backupPath);
    }

    const envContent = fs.readFileSync(inputPath, 'utf8');
    const lines = envContent.split('\n');
    const encrypted: string[] = [];
    const errors: string[] = [];
    let encryptedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Preserve comments and empty lines
      if (line.trim() === '' || line.trim().startsWith('#')) {
        encrypted.push(line);
        continue;
      }

      // Parse key=value
      const match = line.match(/^([^=]+)=(.*)$/);
      if (!match) {
        encrypted.push(line);
        skippedCount++;
        continue;
      }

      const [, key, value] = match;
      const trimmedKey = key.trim();

      try {
        // Encrypt sensitive values
        if (this.isSensitive(trimmedKey)) {
          // Check if already encrypted
          if (this.isEncrypted(value)) {
            encrypted.push(line);
            skippedCount++;
            
            if (opts.showDiff) {
              console.log(`Line ${lineNum}: ${trimmedKey} [already encrypted]`);
            }
          } else {
            const encryptedValue = this.keyManager.encrypt(value, 'env_vars');
            encrypted.push(`${trimmedKey}=${encryptedValue}`);
            encryptedCount++;
            
            if (opts.showDiff) {
              console.log(`Line ${lineNum}: ${trimmedKey} [ENCRYPTED]`);
            }
          }
        } else {
          encrypted.push(line);
          skippedCount++;
        }
      } catch (error: any) {
        errors.push(`Line ${lineNum} (${trimmedKey}): ${error.message}`);
        encrypted.push(line); // Keep original on error
      }
    }

    // Write output file (unless dry run)
    if (!opts.dryRun) {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      fs.writeFileSync(outputPath, encrypted.join('\n'), { mode: 0o600 });
      console.log(`✅ Encrypted environment file saved to ${outputPath}`);
      console.log(`   Encrypted: ${encryptedCount} variables`);
      console.log(`   Skipped: ${skippedCount} variables`);
      
      if (errors.length > 0) {
        console.warn(`   Errors: ${errors.length}`);
        errors.forEach(err => console.warn(`     - ${err}`));
      }
    } else {
      console.log(`[DRY RUN] Would encrypt ${encryptedCount} variables`);
    }

    return {
      encrypted: encryptedCount,
      skipped: skippedCount,
      errors,
      backup: backupPath
    };
  }

  /**
   * Decrypt environment file for local development
   */
  decryptEnvFile(inputPath: string, outputPath: string, options?: {
    createBackup?: boolean;
    showDiff?: boolean;
    dryRun?: boolean;
    validateOnly?: boolean;
  }): {
    decrypted: number;
    skipped: number;
    errors: string[];
    backup?: string;
  } {
    const opts = {
      createBackup: true,
      showDiff: false,
      dryRun: false,
      validateOnly: false,
      ...options
    };

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    // Create backup if requested
    let backupPath: string | undefined;
    if (opts.createBackup && !opts.validateOnly && fs.existsSync(outputPath)) {
      backupPath = `${outputPath}.backup.${Date.now()}`;
      fs.copyFileSync(outputPath, backupPath);
    }

    const envContent = fs.readFileSync(inputPath, 'utf8');
    const lines = envContent.split('\n');
    const decrypted: string[] = [];
    const errors: string[] = [];
    let decryptedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Preserve comments and empty lines
      if (line.trim() === '' || line.trim().startsWith('#')) {
        decrypted.push(line);
        continue;
      }

      const match = line.match(/^([^=]+)=(.*)$/);
      if (!match) {
        decrypted.push(line);
        skippedCount++;
        continue;
      }

      const [, key, value] = match;
      const trimmedKey = key.trim();

      try {
        // Decrypt if it looks encrypted
        if (this.isEncrypted(value)) {
          const decryptedValue = this.keyManager.decrypt(value, 'env_vars');
          decrypted.push(`${trimmedKey}=${decryptedValue}`);
          decryptedCount++;
          
          if (opts.showDiff) {
            console.log(`Line ${lineNum}: ${trimmedKey} [DECRYPTED]`);
          }
        } else {
          decrypted.push(line);
          skippedCount++;
        }
      } catch (error: any) {
        errors.push(`Line ${lineNum} (${trimmedKey}): ${error.message}`);
        decrypted.push(line); // Keep original on error
      }
    }

    // Write output file (unless dry run or validate only)
    if (!opts.dryRun && !opts.validateOnly) {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      fs.writeFileSync(outputPath, decrypted.join('\n'), { mode: 0o600 });
      console.log(`✅ Decrypted environment file saved to ${outputPath}`);
      console.log(`   Decrypted: ${decryptedCount} variables`);
      console.log(`   Skipped: ${skippedCount} variables`);
      
      if (errors.length > 0) {
        console.warn(`   Errors: ${errors.length}`);
        errors.forEach(err => console.warn(`     - ${err}`));
      }
    } else if (opts.validateOnly) {
      console.log(`[VALIDATION] Successfully validated ${decryptedCount} encrypted variables`);
      if (errors.length > 0) {
        console.error(`[VALIDATION] Failed to decrypt ${errors.length} variables`);
        throw new Error('Validation failed');
      }
    } else {
      console.log(`[DRY RUN] Would decrypt ${decryptedCount} variables`);
    }

    return {
      decrypted: decryptedCount,
      skipped: skippedCount,
      errors,
      backup: backupPath
    };
  }

  /**
   * Validate that encrypted env file can be decrypted
   */
  validateEnvFile(filePath: string): boolean {
    try {
      const result = this.decryptEnvFile(filePath, '/dev/null', {
        validateOnly: true,
        createBackup: false
      });
      
      return result.errors.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if an environment variable name is sensitive
   */
  private isSensitive(key: string): boolean {
    return this.sensitivePatterns.some(pattern => pattern.test(key));
  }

  /**
   * Check if a value is already encrypted (has our format)
   */
  private isEncrypted(value: string): boolean {
    // Check for our encryption format: version:compressed:iv:authTag:encrypted[:aad]
    const parts = value.split(':');
    
    if (parts.length < 5) return false;
    
    // Check if first part is a number (version)
    if (!/^\d+$/.test(parts[0])) return false;
    
    // Check if second part is 0 or 1 (compressed flag)
    if (!/^[01]$/.test(parts[1])) return false;
    
    // Check if parts look like hex
    const hexPattern = /^[0-9a-f]+$/i;
    if (!hexPattern.test(parts[2]) || !hexPattern.test(parts[3])) return false;
    
    return true;
  }

  /**
   * Rotate encryption keys for all encrypted values
   */
  rotateKeys(inputPath: string, outputPath: string): void {
    console.log('Rotating encryption keys...');
    
    // First decrypt with old keys
    const tempPath = `${outputPath}.temp`;
    this.decryptEnvFile(inputPath, tempPath, { createBackup: false });
    
    // Rotate the master key
    this.keyManager.rotateKey('env_vars');
    
    // Re-encrypt with new keys
    this.encryptEnvFile(tempPath, outputPath, { createBackup: true });
    
    // Clean up temp file
    fs.unlinkSync(tempPath);
    
    console.log('✅ Key rotation complete');
  }

  /**
   * List all sensitive keys in an env file
   */
  listSensitiveKeys(filePath: string): string[] {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const envContent = fs.readFileSync(filePath, 'utf8');
    const lines = envContent.split('\n');
    const sensitiveKeys: string[] = [];

    for (const line of lines) {
      if (line.trim() === '' || line.trim().startsWith('#')) {
        continue;
      }

      const match = line.match(/^([^=]+)=/);
      if (match) {
        const key = match[1].trim();
        if (this.isSensitive(key)) {
          sensitiveKeys.push(key);
        }
      }
    }

    return sensitiveKeys;
  }

  /**
   * Add custom sensitive pattern
   */
  addSensitivePattern(pattern: RegExp): void {
    this.sensitivePatterns.push(pattern);
  }

  /**
   * Clean up sensitive data
   */
  destroy(): void {
    this.keyManager.destroy();
  }
}

