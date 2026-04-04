import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const claudeStart = vi.fn();
  const codexStart = vi.fn();
  const grokStart = vi.fn();

  const idleUsage = {
    costUsd: 0,
    tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
  };

  class MockClaudeEngine {
    start = claudeStart;
    send = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    compact = vi.fn();
    status = () => ({
      state: 'running' as const,
      sessionId: null,
      model: 'claude-opus-4-20250514',
      usage: idleUsage,
    });
    getSessionId = () => null;
  }

  class MockCodexEngine {
    start = codexStart;
    send = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    compact = vi.fn();
    status = () => ({
      state: 'running' as const,
      sessionId: null,
      model: 'gpt-5.4',
      usage: idleUsage,
    });
    getSessionId = () => null;
  }

  class MockGrokEngine {
    start = grokStart;
    send = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    compact = vi.fn();
    status = () => ({
      state: 'running' as const,
      sessionId: null,
      model: 'grok-4-1-fast',
      usage: idleUsage,
    });
    getSessionId = () => null;
  }

  return {
    claudeStart,
    codexStart,
    grokStart,
    MockClaudeEngine,
    MockCodexEngine,
    MockGrokEngine,
  };
});

vi.mock('../engines/claude-engine.js', () => ({
  ClaudeEngine: hoisted.MockClaudeEngine,
}));

vi.mock('../engines/codex-engine.js', () => ({
  CodexEngine: hoisted.MockCodexEngine,
}));

vi.mock('../engines/grok-engine.js', () => ({
  GrokEngine: hoisted.MockGrokEngine,
}));

import { SessionManager } from '../session-manager.js';

const { claudeStart, codexStart, grokStart } = hoisted;

describe('SessionManager', () => {
  beforeEach(() => {
    claudeStart.mockReset();
    codexStart.mockReset();
    grokStart.mockReset();
    claudeStart.mockResolvedValue(undefined);
    codexStart.mockResolvedValue(undefined);
    grokStart.mockResolvedValue(undefined);
  });

  describe('resolveModelRoute', () => {
    it('should map opus alias to claude-opus-4-20250514', () => {
      const manager = new SessionManager({});
      const route = manager.resolveModelRoute('opus');

      expect(route.engine).toBe('claude');
      expect(route.model).toBe('claude-opus-4-20250514');
      expect(route.source).toBe('alias');
    });

    it('should map codex alias to gpt-5.4 on codex engine', () => {
      const manager = new SessionManager({});
      const route = manager.resolveModelRoute('codex');

      expect(route.engine).toBe('codex');
      expect(route.model).toBe('gpt-5.4');
    });

    it('should map grok-3 alias for grok engine', () => {
      const manager = new SessionManager({});
      const route = manager.resolveModelRoute('grok-3');

      expect(route.engine).toBe('grok');
      expect(route.model).toBe('grok-3');
    });
  });

  describe('startSession fallback chain', () => {
    it('should fall back to codex when claude start fails', async () => {
      claudeStart.mockRejectedValueOnce(new Error('claude unavailable'));

      const manager = new SessionManager({
        defaultFallbackChain: ['claude', 'codex', 'grok'],
        claude: { model: 'claude-opus-4-6' },
        codex: { model: 'gpt-5.4' },
      });

      await manager.startSession({ name: 'alpha', model: 'opus' });

      expect(claudeStart).toHaveBeenCalledTimes(1);
      expect(codexStart).toHaveBeenCalledTimes(1);
      expect(grokStart).not.toHaveBeenCalled();

      const session = manager.getSessionStatus('alpha');
      expect(session?.engine).toBe('codex');
    });

    it('should not fall back when defaultFallbackChain is empty', async () => {
      claudeStart.mockRejectedValueOnce(new Error('claude unavailable'));

      const manager = new SessionManager({
        defaultFallbackChain: [],
        claude: { model: 'claude-opus-4-6' },
        codex: { model: 'gpt-5.4' },
      });

      await expect(
        manager.startSession({ name: 'beta', model: 'opus' }),
      ).rejects.toThrow(/Failed to start claude session/);

      expect(codexStart).not.toHaveBeenCalled();
    });

    it('should throw the last error when every engine fails', async () => {
      claudeStart.mockRejectedValue(new Error('claude unavailable'));
      codexStart.mockRejectedValue(new Error('codex unavailable'));
      grokStart.mockRejectedValue(new Error('grok unavailable'));

      const manager = new SessionManager({
        defaultFallbackChain: ['claude', 'codex', 'grok'],
        claude: { model: 'claude-opus-4-6' },
        codex: { model: 'gpt-5.4' },
        grok: { model: 'grok-4-1-fast' },
      });

      await expect(
        manager.startSession({ name: 'gamma', model: 'opus' }),
      ).rejects.toThrow(/grok unavailable/);
    });
  });
});
