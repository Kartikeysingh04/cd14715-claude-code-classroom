import { describe, expect, it, vi } from 'vitest';
import {
  ErrorCodes,
  ReviewError,
  formatError,
  isReviewError,
  withRetry,
  withTimeout
} from '../src/utils/error-handler.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';

describe('Error Handler', () => {
  it('should identify ReviewError instances', () => {
    const error = new ReviewError(
      'Test error',
      ErrorCodes.AGENT_FAILED
    );

    expect(isReviewError(error)).toBe(true);
    expect(isReviewError(new Error('Test error'))).toBe(false);
  });

  it('should format ReviewError correctly', () => {
    const error = new ReviewError(
      'Something failed',
      ErrorCodes.AGENT_FAILED
    );

    expect(formatError(error)).toBe(
      '[AGENT_FAILED] Something failed'
    );
  });

  it('should format standard Error correctly', () => {
    expect(formatError(new Error('Standard error'))).toBe(
      'Standard error'
    );
  });

  it('should format unknown errors', () => {
    expect(formatError('unknown failure')).toBe('unknown failure');
  });

  it('should retry a failed operation and eventually succeed', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;

        if (attempts < 3) {
          throw new Error('Temporary failure');
        }

        return 'success';
      },
      3,
      1
    );

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('should throw RETRY_EXHAUSTED after all retries fail', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('Permanent failure');
        },
        3,
        1
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED
    });

    expect(attempts).toBe(3);
  });

  it('should timeout a slow operation', async () => {
    await expect(
      withTimeout(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('too late'), 50);
          }),
        5,
        'Test timeout'
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT,
      metadata: {
        timeoutMs: 5
      }
    });
  });

  it('should return a successful operation before timeout', async () => {
    const result = await withTimeout(
      async () => 'completed',
      100
    );

    expect(result).toBe('completed');
  });
});

describe('RateLimiter', () => {
  it('should initialize with configured limits', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
      maxConcurrent: 2
    });

    const stats = limiter.getStats();

    expect(stats.requestsInLastMinute).toBe(0);
    expect(stats.tokensInLastMinute).toBe(0);
    expect(stats.activeRequests).toBe(0);
  });

  it('should allow a request when under the limit', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 2,
      tokensPerMinute: 1000,
      maxConcurrent: 2
    });

    await limiter.acquire(100);

    const stats = limiter.getStats();

    expect(stats.requestsInLastMinute).toBe(1);
    expect(stats.tokensInLastMinute).toBe(100);

    limiter.release();
  });

  it('should execute withRateLimit and release the slot', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
      maxConcurrent: 2
    });

    const result = await limiter.withRateLimit(
      async () => 'completed',
      50
    );

    expect(result).toBe('completed');

    const stats = limiter.getStats();
    expect(stats.activeRequests).toBe(0);
  });

  it('should not leave active requests after a failed operation', async () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
      maxConcurrent: 2
    });

    await expect(
      limiter.withRateLimit(
        async () => {
          throw new Error('Operation failed');
        },
        50
      )
    ).rejects.toThrow('Operation failed');

    expect(limiter.getStats().activeRequests).toBe(0);
  });
});
