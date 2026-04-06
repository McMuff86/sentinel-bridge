import { describe, it, expect } from 'vitest';
import {
  EngineError,
  categorizeHttpStatus,
  parseRetryAfterMs,
  toEngineError,
} from '../errors.js';

describe('EngineError', () => {
  it('stores category and message', () => {
    const err = new EngineError('rate limited', 'rate_limited', { httpStatus: 429 });
    expect(err.message).toBe('rate limited');
    expect(err.category).toBe('rate_limited');
    expect(err.httpStatus).toBe(429);
    expect(err.retriable).toBe(true);
    expect(err.name).toBe('EngineError');
  });

  it('defaults retriable based on category', () => {
    expect(new EngineError('x', 'rate_limited').retriable).toBe(true);
    expect(new EngineError('x', 'transient').retriable).toBe(true);
    expect(new EngineError('x', 'timeout').retriable).toBe(true);
    expect(new EngineError('x', 'unavailable').retriable).toBe(false);
    expect(new EngineError('x', 'auth_expired').retriable).toBe(false);
    expect(new EngineError('x', 'context_overflow').retriable).toBe(false);
    expect(new EngineError('x', 'cancelled').retriable).toBe(false);
    expect(new EngineError('x', 'unknown').retriable).toBe(false);
  });

  it('allows overriding retriable', () => {
    const err = new EngineError('x', 'unknown', { retriable: true });
    expect(err.retriable).toBe(true);
  });

  it('stores retryAfterMs', () => {
    const err = new EngineError('x', 'rate_limited', { retryAfterMs: 5000 });
    expect(err.retryAfterMs).toBe(5000);
  });
});

describe('categorizeHttpStatus', () => {
  it('maps 401/403 to auth_expired', () => {
    expect(categorizeHttpStatus(401)).toBe('auth_expired');
    expect(categorizeHttpStatus(403)).toBe('auth_expired');
  });

  it('maps 429 to rate_limited', () => {
    expect(categorizeHttpStatus(429)).toBe('rate_limited');
  });

  it('maps 413 to context_overflow', () => {
    expect(categorizeHttpStatus(413)).toBe('context_overflow');
  });

  it('maps 5xx to transient', () => {
    expect(categorizeHttpStatus(500)).toBe('transient');
    expect(categorizeHttpStatus(502)).toBe('transient');
    expect(categorizeHttpStatus(503)).toBe('transient');
  });

  it('maps other codes to unknown', () => {
    expect(categorizeHttpStatus(400)).toBe('unknown');
    expect(categorizeHttpStatus(404)).toBe('unknown');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds to milliseconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
  });

  it('returns undefined for null/empty', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
  });

  it('returns undefined for non-numeric', () => {
    expect(parseRetryAfterMs('abc')).toBeUndefined();
  });
});

describe('toEngineError', () => {
  it('returns the same EngineError if already one', () => {
    const err = new EngineError('x', 'timeout');
    expect(toEngineError(err)).toBe(err);
  });

  it('wraps plain Error with fallback category', () => {
    const plain = new Error('boom');
    const wrapped = toEngineError(plain, 'transient');
    expect(wrapped).toBeInstanceOf(EngineError);
    expect(wrapped.category).toBe('transient');
    expect(wrapped.message).toBe('boom');
  });

  it('wraps non-Error values', () => {
    const wrapped = toEngineError('string error');
    expect(wrapped).toBeInstanceOf(EngineError);
    expect(wrapped.message).toBe('string error');
    expect(wrapped.category).toBe('unknown');
  });
});
