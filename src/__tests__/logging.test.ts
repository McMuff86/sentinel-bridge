import { describe, it, expect, vi } from 'vitest';
import { StructuredLogger } from '../logging.js';
import type { ExternalLogger } from '../logging.js';

function mockLogger(): ExternalLogger & { calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = [];
  return {
    calls,
    info: vi.fn((msg: string) => calls.push({ level: 'info', message: msg })),
    warn: vi.fn((msg: string) => calls.push({ level: 'warn', message: msg })),
    error: vi.fn((msg: string) => calls.push({ level: 'error', message: msg })),
  };
}

describe('StructuredLogger', () => {
  it('forwards info logs to external logger', () => {
    const ext = mockLogger();
    const logger = new StructuredLogger(ext);

    logger.info('session', 'Session started', { session: 'test-1', engine: 'claude' });

    expect(ext.calls).toHaveLength(1);
    expect(ext.calls[0]!.level).toBe('info');
    expect(ext.calls[0]!.message).toContain('[sentinel-bridge]');
    expect(ext.calls[0]!.message).toContain('"category":"session"');
    expect(ext.calls[0]!.message).toContain('"session":"test-1"');
  });

  it('forwards warn and error to correct external methods', () => {
    const ext = mockLogger();
    const logger = new StructuredLogger(ext);

    logger.warn('fallback', 'Engine failed');
    logger.error('engine', 'Crash');

    expect(ext.calls[0]!.level).toBe('warn');
    expect(ext.calls[1]!.level).toBe('error');
  });

  it('respects minLevel filtering', () => {
    const ext = mockLogger();
    const logger = new StructuredLogger(ext, 'warn');

    logger.debug('session', 'debug msg');
    logger.info('session', 'info msg');
    logger.warn('session', 'warn msg');
    logger.error('session', 'error msg');

    expect(ext.calls).toHaveLength(2);
    expect(ext.calls[0]!.message).toContain('warn msg');
    expect(ext.calls[1]!.message).toContain('error msg');
  });

  it('includes metadata in JSON output', () => {
    const ext = mockLogger();
    const logger = new StructuredLogger(ext);

    logger.info('routing', 'Resolved route', {
      session: 'my-session',
      engine: 'grok',
      meta: { model: 'grok-4-1-fast', attempt: 2 },
    });

    const parsed = JSON.parse(ext.calls[0]!.message.replace('[sentinel-bridge] ', ''));
    expect(parsed.category).toBe('routing');
    expect(parsed.session).toBe('my-session');
    expect(parsed.engine).toBe('grok');
    expect(parsed.meta.model).toBe('grok-4-1-fast');
    expect(parsed.meta.attempt).toBe(2);
    expect(parsed.ts).toBeDefined();
  });

  it('does not throw without external logger', () => {
    const logger = new StructuredLogger(undefined);
    expect(() => logger.info('session', 'no-op')).not.toThrow();
    expect(() => logger.error('engine', 'no-op')).not.toThrow();
  });

  it('includes durationMs when provided', () => {
    const ext = mockLogger();
    const logger = new StructuredLogger(ext);

    logger.info('session', 'Completed', { durationMs: 1234 });

    const parsed = JSON.parse(ext.calls[0]!.message.replace('[sentinel-bridge] ', ''));
    expect(parsed.durationMs).toBe(1234);
  });
});
