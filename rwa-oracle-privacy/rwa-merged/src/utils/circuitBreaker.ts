// src/utils/circuitBreaker.ts
// ─────────────────────────────────────────────────────────────
//  Circuit Breaker
//  Prevents cascading failures when StarkNet RPC is unavailable.
//
//  States:
//    CLOSED    — normal operation, requests pass through
//    OPEN      — failing, requests rejected immediately
//    HALF_OPEN — testing recovery with limited requests
// ─────────────────────────────────────────────────────────────

import { logger } from "./logger";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  failureThreshold: number;  // consecutive failures to open
  successThreshold: number;  // consecutive successes to close from half-open
  timeout: number;           // ms before OPEN → HALF_OPEN
  onOpen?:     () => void;
  onClose?:    () => void;
  onHalfOpen?: () => void;
}

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly name: string;
  private readonly opts: CircuitBreakerOptions;

  constructor(name: string, opts: CircuitBreakerOptions) {
    this.name = name;
    this.opts = opts;
  }

  /**
   * Execute a function through the circuit breaker.
   * Returns null if the circuit is open (without calling fn).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.opts.timeout) {
        this.transitionTo("HALF_OPEN");
      } else {
        logger.warn(`[CircuitBreaker:${this.name}] OPEN — request rejected (retry in ${Math.round((this.opts.timeout - elapsed) / 1000)}s)`);
        return null;
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err: any) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.opts.successThreshold) {
        this.transitionTo("CLOSED");
      }
    }
  }

  private onFailure(err: Error): void {
    this.lastFailureTime = Date.now();
    this.successCount = 0;
    this.failureCount++;
    logger.warn(`[CircuitBreaker:${this.name}] Failure ${this.failureCount}/${this.opts.failureThreshold}: ${err.message}`);

    if (
      this.state === "HALF_OPEN" ||
      this.failureCount >= this.opts.failureThreshold
    ) {
      this.transitionTo("OPEN");
    }
  }

  private transitionTo(newState: State): void {
    logger.info(`[CircuitBreaker:${this.name}] ${this.state} → ${newState}`);
    this.state = newState;
    if (newState === "OPEN")     { this.opts.onOpen?.(); }
    if (newState === "CLOSED")   { this.opts.onClose?.(); this.failureCount = 0; }
    if (newState === "HALF_OPEN"){ this.opts.onHalfOpen?.(); this.successCount = 0; }
  }

  getState(): State { return this.state; }
  getFailureCount(): number { return this.failureCount; }
}
