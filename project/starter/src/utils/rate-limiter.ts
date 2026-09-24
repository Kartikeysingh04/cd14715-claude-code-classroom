/**
 * Rate limiter for Claude Agent SDK requests.
 *
 * Controls:
 * - Maximum requests per minute
 * - Maximum estimated tokens per minute
 * - Maximum concurrent requests
 */

export interface RateLimiterConfig {
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  maxConcurrent: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 100000,
  maxConcurrent: 5
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly requestHistory: RequestRecord[] = [];
  private activeRequests = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config
    };
  }

  /**
   * Acquire permission to make a request.
   */
  async acquire(estimatedTokens = 0): Promise<void> {
    await this.waitForSlot();
    await this.waitForRateLimit(estimatedTokens);

    this.activeRequests++;

    this.pruneOldRecords();

    this.requestHistory.push({
      timestamp: Date.now(),
      tokens: estimatedTokens
    });
  }

  /**
   * Check whether a request can proceed immediately.
   */
  canProceed(estimatedTokens = 0): boolean {
    this.pruneOldRecords();

    if (this.activeRequests >= this.config.maxConcurrent) {
      return false;
    }

    if (this.requestHistory.length >= this.config.maxRequestsPerMinute) {
      return false;
    }

    const usedTokens = this.requestHistory.reduce(
      (total, record) => total + record.tokens,
      0
    );

    return usedTokens + estimatedTokens <= this.config.maxTokensPerMinute;
  }

  /**
   * Wait until a concurrency slot becomes available.
   */
  private async waitForSlot(): Promise<void> {
    if (this.activeRequests < this.config.maxConcurrent) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Wait until request/token rate limits allow the request.
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      this.pruneOldRecords();

      const oldestRequest = this.requestHistory[0];

      if (!oldestRequest) {
        await this.sleep(100);
        continue;
      }

      const elapsed = Date.now() - oldestRequest.timestamp;
      const waitTime = Math.max(100, 60_000 - elapsed + 100);

      await this.sleep(Math.min(waitTime, 5_000));
    }
  }

  /**
   * Remove request records older than one minute.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60_000;

    while (
      this.requestHistory.length > 0 &&
      this.requestHistory[0] &&
      this.requestHistory[0].timestamp < cutoff
    ) {
      this.requestHistory.shift();
    }
  }

  /**
   * Release a concurrency slot.
   *
   * Optionally updates the most recent request with the actual token count.
   */
  release(actualTokens?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    if (actualTokens !== undefined) {
      const lastRequest =
        this.requestHistory[this.requestHistory.length - 1];

      if (lastRequest) {
        lastRequest.tokens = actualTokens;
      }
    }

    const next = this.waitQueue.shift();

    if (next) {
      next();
    }
  }

  /**
   * Execute an operation under rate limiting.
   */
  async withRateLimit<T>(
    operation: () => Promise<T>,
    estimatedTokens = 0
  ): Promise<T> {
    await this.acquire(estimatedTokens);

    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  /**
   * Get current limiter statistics.
   */
  getStats(): {
    activeRequests: number;
    queuedRequests: number;
    requestsInLastMinute: number;
    tokensInLastMinute: number;
  } {
    this.pruneOldRecords();

    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.waitQueue.length,
      requestsInLastMinute: this.requestHistory.length,
      tokensInLastMinute: this.requestHistory.reduce(
        (total, record) => total + record.tokens,
        0
      )
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const rateLimiter = new RateLimiter();
