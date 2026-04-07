import { describe, it, expect, beforeEach } from 'vitest';

import { CircuitBreaker } from '../orchestration/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 100,
      halfOpenSuccessThreshold: 1,
    });
  });

  describe('closed state', () => {
    it('should allow requests by default', () => {
      expect(cb.isAllowed('claude')).toBe(true);
      expect(cb.getSnapshot('claude').state).toBe('closed');
    });

    it('should remain closed after fewer failures than threshold', () => {
      cb.recordFailure('claude');
      cb.recordFailure('claude');
      expect(cb.isAllowed('claude')).toBe(true);
      expect(cb.getSnapshot('claude').consecutiveFailures).toBe(2);
    });

    it('should reset failure count on success', () => {
      cb.recordFailure('claude');
      cb.recordFailure('claude');
      cb.recordSuccess('claude');
      expect(cb.getSnapshot('claude').consecutiveFailures).toBe(0);
    });
  });

  describe('open state', () => {
    it('should open after reaching failure threshold', () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      expect(cb.getSnapshot('grok').state).toBe('open');
      expect(cb.isAllowed('grok')).toBe(false);
    });

    it('should block requests when open', () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      expect(cb.isAllowed('grok')).toBe(false);
    });

    it('should track total failures', () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      expect(cb.getSnapshot('grok').totalFailures).toBe(3);
    });
  });

  describe('half-open state', () => {
    it('should transition to half-open after cooldown', async () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      expect(cb.isAllowed('grok')).toBe(false);

      // Wait for cooldown
      await new Promise(r => setTimeout(r, 120));

      expect(cb.isAllowed('grok')).toBe(true);
      expect(cb.getSnapshot('grok').state).toBe('half-open');
    });

    it('should close circuit on success in half-open', async () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');

      await new Promise(r => setTimeout(r, 120));
      cb.isAllowed('grok'); // trigger half-open transition

      cb.recordSuccess('grok');
      expect(cb.getSnapshot('grok').state).toBe('closed');
      expect(cb.getSnapshot('grok').consecutiveFailures).toBe(0);
    });

    it('should re-open circuit on failure in half-open', async () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');

      await new Promise(r => setTimeout(r, 120));
      cb.isAllowed('grok'); // trigger half-open transition

      cb.recordFailure('grok');
      expect(cb.getSnapshot('grok').state).toBe('open');
    });
  });

  describe('engine isolation', () => {
    it('should track circuits independently per engine', () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');

      expect(cb.getSnapshot('grok').state).toBe('open');
      expect(cb.getSnapshot('claude').state).toBe('closed');
      expect(cb.getSnapshot('ollama').state).toBe('closed');
    });
  });

  describe('manual reset', () => {
    it('should reset circuit to closed', () => {
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      cb.recordFailure('grok');
      expect(cb.getSnapshot('grok').state).toBe('open');

      cb.reset('grok');
      expect(cb.getSnapshot('grok').state).toBe('closed');
      expect(cb.getSnapshot('grok').consecutiveFailures).toBe(0);
      expect(cb.isAllowed('grok')).toBe(true);
    });
  });

  describe('getAllSnapshots', () => {
    it('should return snapshots for all 4 engines', () => {
      const snapshots = cb.getAllSnapshots();
      expect(snapshots).toHaveLength(4);
      const engines = snapshots.map(s => s.engine);
      expect(engines).toContain('claude');
      expect(engines).toContain('codex');
      expect(engines).toContain('grok');
      expect(engines).toContain('ollama');
    });
  });

  describe('statistics', () => {
    it('should track total successes and failures', () => {
      cb.recordSuccess('claude');
      cb.recordSuccess('claude');
      cb.recordFailure('claude');
      cb.recordSuccess('claude');

      const snap = cb.getSnapshot('claude');
      expect(snap.totalSuccesses).toBe(3);
      expect(snap.totalFailures).toBe(1);
    });
  });
});
