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
SHA-256:  81B10AF1B22F7CE7BCBD661ECB26C4254C92BEAFA486FF8C590AF7AA5ED230F4
SHA-512:  31DBEC0B5F1493DDAC2BB8C127637F5255549FD442D77A6A891A47EC0B6F480B1ED40913B1CB275B39688731AF671484451BEEC19D95DD4A86C79F8C141A39F0
MD5:      BDB1B08036F7D0D5697821434C189688
File Size: 2392 bytes

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
import pino from 'pino';
import { config } from '../config.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.join(__dirname, '../../logs');

const transports = config.logToFile
  ? {
      targets: [
        // Console output with pretty printing
        {
          target: 'pino-pretty',
          level: config.logLevel,
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            destination: 1 // stdout
          }
        },
        // File output with rotation
        {
          target: 'pino/file',
          level: config.logLevel,
          options: {
            destination: path.join(logDir, 'oracle.log'),
            mkdir: true
          }
        },
        // Error file
        {
          target: 'pino/file',
          level: 'error',
          options: {
            destination: path.join(logDir, 'error.log'),
            mkdir: true
          }
        }
      ]
    }
  : {
      target: 'pino-pretty',
      level: config.logLevel,
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    };

export const logger = pino({
  level: config.logLevel,
  transport: transports,
  base: {
    env: config.nodeEnv,
    service: 'starknet-rwa-oracle'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// Helper functions for structured logging
export const logFetch = (source: string, symbol: string, success: boolean, price?: number) => {
  logger.info({
    type: 'fetch',
    source,
    symbol,
    success,
    price
  }, `Fetched ${symbol} from ${source}`);
};

export const logUpdate = (symbol: string, price: number, txHash: string) => {
  logger.info({
    type: 'update',
    symbol,
    price,
    txHash
  }, `Updated ${symbol} on-chain`);
};

export const logError = (context: string, error: any, metadata?: any) => {
  logger.error({
    type: 'error',
    context,
    error: error.message || error,
    stack: error.stack,
    ...metadata
  }, `Error in ${context}`);
};

export const logMetric = (metric: string, value: number, unit?: string) => {
  logger.info({
    type: 'metric',
    metric,
    value,
    unit
  }, `Metric: ${metric} = ${value}${unit || ''}`);
};

