import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HealthChecker } from '../orchestration/health-check.js';
import { CircuitBreaker } from '../orchestration/circuit-breaker.js';

// Mock fetch for HTTP probes
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('HealthChecker', () => {
  let checker: HealthChecker;

  beforeEach(() => {
    mockFetch.mockReset();
    checker = new HealthChecker({
      intervalMs: 0, // disable periodic for tests
      probeTimeoutMs: 1000,
      ollamaBaseUrl: 'http://localhost:11434/v1',
    });
  });

  afterEach(() => {
    checker.stop();
  });

  describe('CLI engine checks', () => {
    it('should check claude CLI availability', async () => {
      const result = await checker.check('claude');
      expect(result.engine).toBe('claude');
      expect(typeof result.healthy).toBe('boolean');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.checkedAt).toBeTruthy();
    });

    it('should check codex CLI availability', async () => {
      const result = await checker.check('codex');
      expect(result.engine).toBe('codex');
      expect(typeof result.healthy).toBe('boolean');
    });
  });

  describe('HTTP engine checks', () => {
    it('should probe Ollama via HTTP', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const result = await checker.check('ollama');
      expect(result.engine).toBe('ollama');
      expect(result.healthy).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle Ollama down', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await checker.check('ollama');
      expect(result.healthy).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should handle Grok without API key', async () => {
      const result = await checker.check('grok');
      expect(result.healthy).toBe(false);
      // No API key configured
    });

    it('should probe Grok with API key', async () => {
      const grokChecker = new HealthChecker({
        intervalMs: 0,
        probeTimeoutMs: 1000,
        grokBaseUrl: 'https://api.x.ai/v1',
        grokApiKey: 'test-key',
      });

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      const result = await grokChecker.check('grok');
      expect(result.healthy).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        }),
      );
    });
  });

  describe('checkAll', () => {
    it('should check all 4 engines', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const results = await checker.checkAll();
      expect(results).toHaveLength(4);
      const engines = results.map(r => r.engine);
      expect(engines).toContain('claude');
      expect(engines).toContain('codex');
      expect(engines).toContain('grok');
      expect(engines).toContain('ollama');
    });
  });

  describe('getAllResults', () => {
    it('should return "Not checked yet" for unchecked engines', () => {
      const results = checker.getAllResults();
      expect(results).toHaveLength(4);
      for (const r of results) {
        expect(r.error).toBe('Not checked yet');
      }
    });

    it('should return cached results after check', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await checker.checkAll();
      const results = checker.getAllResults();
      for (const r of results) {
        expect(r.checkedAt).toBeTruthy();
      }
    });
  });

  describe('circuit breaker integration', () => {
    it('should record success on healthy check', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
      const checkerWithCB = new HealthChecker({
        intervalMs: 0,
        probeTimeoutMs: 1000,
        ollamaBaseUrl: 'http://localhost:11434/v1',
      }, cb);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await checkerWithCB.check('ollama');

      expect(cb.getSnapshot('ollama').totalSuccesses).toBe(1);
    });

    it('should NOT record failure on unhealthy check', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
      const checkerWithCB = new HealthChecker({
        intervalMs: 0,
        probeTimeoutMs: 1000,
        ollamaBaseUrl: 'http://localhost:11434/v1',
      }, cb);

      mockFetch.mockRejectedValueOnce(new Error('down'));
      await checkerWithCB.check('ollama');

      // Health check failures should NOT trip the circuit
      expect(cb.getSnapshot('ollama').totalFailures).toBe(0);
      expect(cb.getSnapshot('ollama').state).toBe('closed');
    });
  });

  describe('periodic checks', () => {
    it('should start and stop without errors', () => {
      const periodicChecker = new HealthChecker({ intervalMs: 50, probeTimeoutMs: 100 });
      mockFetch.mockResolvedValue({ ok: true });
      periodicChecker.start();
      periodicChecker.stop();
    });
  });
});
