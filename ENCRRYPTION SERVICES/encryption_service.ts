// ============================================
// ENCRYPTION & KEY MANAGEMENT MICROSERVICE
// Port: 3001
// ============================================

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import argon2 from 'argon2';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SECURE KEY MANAGER
// ============================================

class SecureKeyManager {
  private masterKey: Buffer;
  private derivedKeys: Map<string, Buffer> = new Map();
  private encryptionSalt: Buffer;
  
  constructor(masterPassword: string, saltPath: string = './secure/salt.bin') {
    if (fs.existsSync(saltPath)) {
      this.encryptionSalt = fs.readFileSync(saltPath);
    } else {
      this.encryptionSalt = crypto.randomBytes(32);
      fs.mkdirSync('./secure', { recursive: true });
      fs.writeFileSync(saltPath, this.encryptionSalt, { mode: 0o600 });
    }
    
    this.masterKey = crypto.pbkdf2Sync(masterPassword, this.encryptionSalt, 600000, 32, 'sha512');
  }

  deriveKey(purpose: string): Buffer {
    if (!this.derivedKeys.has(purpose)) {
      const hmac = crypto.createHmac('sha256', this.masterKey);
      hmac.update(Buffer.from(purpose, 'utf8'));
      this.derivedKeys.set(purpose, hmac.digest());
    }
    return this.derivedKeys.get(purpose)!;
  }

  encrypt(data: string, purpose: string = 'default'): string {
    const key = this.deriveKey(purpose);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  decrypt(encryptedData: string, purpose: string = 'default'): string {
    const key = this.deriveKey(purpose);
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  encryptPrivateKey(privateKey: string): string {
    return this.encrypt(privateKey, 'private_keys');
  }

  decryptPrivateKey(encrypted: string): string {
    return this.decrypt(encrypted, 'private_keys');
  }

  getSecureEnv(key: string): string {
    const encrypted = process.env[key];
    if (!encrypted) throw new Error(`Missing env var: ${key}`);
    
    try {
      return this.decrypt(encrypted, 'env_vars');
    } catch {
      return encrypted;
    }
  }
}

// ============================================
// ENVIRONMENT ENCRYPTOR
// ============================================

class EnvironmentEncryptor {
  private keyManager: SecureKeyManager;

  constructor(masterPassword: string) {
    this.keyManager = new SecureKeyManager(masterPassword);
  }

  encryptEnvFile(inputPath: string, outputPath: string): void {
    const envContent = fs.readFileSync(inputPath, 'utf8');
    const lines = envContent.split('\n');
    const encrypted: string[] = [];

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#')) {
        encrypted.push(line);
        continue;
      }

      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=');

      if (this.isSensitive(key)) {
        const encryptedValue = this.keyManager.encrypt(value, 'env_vars');
        encrypted.push(`${key}=${encryptedValue}`);
      } else {
        encrypted.push(line);
      }
    }

    fs.writeFileSync(outputPath, encrypted.join('\n'));
    fs.chmodSync(outputPath, 0o600);
    console.log(`✅ Encrypted environment file saved to ${outputPath}`);
  }

  decryptEnvFile(inputPath: string, outputPath: string): void {
    const envContent = fs.readFileSync(inputPath, 'utf8');
    const lines = envContent.split('\n');
    const decrypted: string[] = [];

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#')) {
        decrypted.push(line);
        continue;
      }

      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=');

      if (value.includes(':') && value.split(':').length === 3) {
        try {
          const decryptedValue = this.keyManager.decrypt(value, 'env_vars');
          decrypted.push(`${key}=${decryptedValue}`);
        } catch {
          decrypted.push(line);
        }
      } else {
        decrypted.push(line);
      }
    }

    fs.writeFileSync(outputPath, decrypted.join('\n'));
    fs.chmodSync(outputPath, 0o600);
    console.log(`✅ Decrypted environment file saved to ${outputPath}`);
  }

  private isSensitive(key: string): boolean {
    const sensitiveKeys = [
      'PRIVATE_KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'API_KEY',
      'MASTER_PASSWORD', 'RELAYER_KEY', 'BTC_RPC_PASS'
    ];
    return sensitiveKeys.some(s => key.toUpperCase().includes(s));
  }
}

// ============================================
// API ENDPOINTS
// ============================================

const keyManager = new SecureKeyManager(
  process.env.MASTER_PASSWORD || 'CHANGE_THIS_IN_PRODUCTION'
);

app.get('/health', (req, res) => {
  res.json({ service: 'encryption', status: 'ok', timestamp: Date.now() });
});

app.post('/api/encrypt', async (req, res) => {
  try {
    const { data, purpose } = req.body;
    const encrypted = keyManager.encrypt(data, purpose || 'default');
    res.json({ encrypted });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/decrypt', async (req, res) => {
  try {
    const { encrypted, purpose } = req.body;
    const decrypted = keyManager.decrypt(encrypted, purpose || 'default');
    res.json({ decrypted });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/encrypt-key', async (req, res) => {
  try {
    const { privateKey } = req.body;
    const encrypted = keyManager.encryptPrivateKey(privateKey);
    res.json({ encrypted });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/decrypt-key', async (req, res) => {
  try {
    const { encrypted } = req.body;
    const privateKey = keyManager.decryptPrivateKey(encrypted);
    res.json({ privateKey });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🔐 Encryption Service running on port ${PORT}`);
});

export { SecureKeyManager, EnvironmentEncryptor };