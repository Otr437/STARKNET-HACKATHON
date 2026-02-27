/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:20
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  C669DDFA1EDC95FF7CA3DB8FAF0081C236225ED092158CF62EE837F6748A3430
SHA-512:  D51F6059FF3F32F86E777BA5FD63DF04D33A932281848FC2465C54AFEA9B3B3B4F4080F4BD12552D5263068F705EE9BC906E5ED19BEE8708EDE4E5347A20E062
MD5:      EE84F6EB7E29183FA00D26EDA24B642D
File Size: 3938 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/
import { config as dotenvConfig } from 'dotenv';
import { OracleConfig } from './types.js';
import { logger } from './utils/logger.js';

dotenvConfig();

function getEnvVar(key: string, required: boolean = true, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || '';
}

function getEnvNumber(key: string, required: boolean = true, defaultValue?: number): number {
  const value = process.env[key];
  if (!value) {
    if (required && defaultValue === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return defaultValue || 0;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): OracleConfig {
  try {
    const config: OracleConfig = {
      // Starknet
      rpcUrl: getEnvVar('STARKNET_RPC_URL'),
      accountAddress: getEnvVar('STARKNET_ACCOUNT_ADDRESS'),
      privateKey: getEnvVar('STARKNET_PRIVATE_KEY'),
      contractAddress: getEnvVar('ORACLE_CONTRACT_ADDRESS', false),
      
      // API Keys
      alphaVantageKey: getEnvVar('ALPHA_VANTAGE_API_KEY'),
      twelveDataKey: getEnvVar('TWELVE_DATA_API_KEY', false),
      polygonIoKey: getEnvVar('POLYGON_IO_API_KEY', false),
      
      // Intervals & Timing
      updateInterval: getEnvNumber('UPDATE_INTERVAL', false, 900000),
      maxRetries: getEnvNumber('MAX_RETRIES', false, 3),
      retryDelay: getEnvNumber('RETRY_DELAY', false, 60000),
      apiTimeout: getEnvNumber('API_TIMEOUT', false, 10000),
      
      // Thresholds
      maxPriceDeviation: getEnvNumber('MAX_PRICE_DEVIATION', false, 10),
      minSourceCount: getEnvNumber('MIN_SOURCE_COUNT', false, 1),
      
      // Logging
      logLevel: getEnvVar('LOG_LEVEL', false, 'info'),
      logToFile: getEnvBoolean('LOG_TO_FILE', true),
      
      // Optional Services
      slackWebhook: getEnvVar('SLACK_WEBHOOK_URL', false),
      telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN', false),
      telegramChatId: getEnvVar('TELEGRAM_CHAT_ID', false),
      redisUrl: getEnvVar('REDIS_URL', false),
      redisEnabled: getEnvBoolean('REDIS_ENABLED', false),
      
      // Environment
      nodeEnv: getEnvVar('NODE_ENV', false, 'production')
    };

    validateConfig(config);
    
    logger.info('Configuration loaded successfully');
    return config;
    
  } catch (error) {
    logger.error({ error }, 'Failed to load configuration');
    throw error;
  }
}

function validateConfig(config: OracleConfig): void {
  // Validate Starknet address format
  if (!config.accountAddress.startsWith('0x')) {
    throw new Error('Invalid Starknet account address format');
  }
  
  // Validate private key format
  if (!config.privateKey.startsWith('0x') && !config.privateKey.match(/^[0-9a-fA-F]+$/)) {
    throw new Error('Invalid private key format');
  }
  
  // Validate API key
  if (!config.alphaVantageKey || config.alphaVantageKey.length < 10) {
    throw new Error('Invalid Alpha Vantage API key');
  }
  
  // Validate intervals
  if (config.updateInterval < 60000) {
    logger.warn('Update interval is less than 1 minute, this may hit rate limits');
  }
  
  if (config.maxPriceDeviation < 1 || config.maxPriceDeviation > 100) {
    throw new Error('Max price deviation must be between 1 and 100');
  }
  
  logger.info({
    rpcUrl: config.rpcUrl,
    accountAddress: config.accountAddress,
    updateInterval: config.updateInterval,
    logLevel: config.logLevel
  }, 'Configuration validated');
}

export const config = loadConfig();

