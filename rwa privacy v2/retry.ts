/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:42:21
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  C80A323D1D29C0AF36C40B21AFEB58C15C4A9AEEA864F113FC1E5D98B846A3A4
SHA-512:  EC6E60B0C76E03D124F46F1A5B49356AFBFDB6FC1762DB3CD4FC8270C27E92669E5CBFC6A284C25FDA4BCB6E660D98EFE56D5527AA9957BC55FFC6E3ED6FF529
MD5:      108DCB4FC7116CA3AFC2D07C005AFE93
File Size: 2572 bytes

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
import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay?: number;
  exponentialBackoff?: boolean;
  onRetry?: (attempt: number, error: any) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  context: string
): Promise<T> {
  const {
    maxRetries,
    baseDelay,
    maxDelay = 300000, // 5 minutes max
    exponentialBackoff = true,
    onRetry
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        logger.error(
          { context, attempt, error: error.message },
          `Failed after ${maxRetries} retries`
        );
        throw error;
      }

      const delay = exponentialBackoff
        ? Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
        : baseDelay;

      logger.warn(
        { context, attempt: attempt + 1, maxRetries, delay },
        `Retry attempt ${attempt + 1}/${maxRetries} in ${delay}ms`
      );

      if (onRetry) {
        onRetry(attempt + 1, error);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function timeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

export class RateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private processing = false;

  constructor(
    private requestsPerWindow: number,
    private windowMs: number
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.requestsPerWindow);

      await Promise.all(batch.map(fn => fn()));

      if (this.queue.length > 0) {
        await sleep(this.windowMs);
      }
    }

    this.processing = false;
  }
}

