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
