import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const claudeStart = vi.fn();
  const codexStart = vi.fn();
  const grokStart = vi.fn();

  const idleUsage = {
    costUsd: 0,
    tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
  };

  // Shared mutable ref so tests can override the usage returned by status()
  const claudeUsageRef = { current: idleUsage };

  class MockClaudeEngine {
    start = claudeStart;
    send = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    compact = vi.fn();
    status = () => ({
      state: 'running' as const,
      sessionId: null,
      model: 'claude-opus-4-6',
      usage: claudeUsageRef.current,
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
    claudeUsageRef,
    idleUsage,
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
    hoisted.claudeUsageRef.current = hoisted.idleUsage;
  });

  describe('resolveModelRoute', () => {
    it('should map opus alias to claude-opus-4-6', () => {
      const manager = new SessionManager({});
      const route = manager.resolveModelRoute('opus');

      expect(route.engine).toBe('claude');
      expect(route.model).toBe('claude-opus-4-6');
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
      expect(session?.routingTrace?.requestedModel).toBe('opus');
      expect(session?.routingTrace?.attempts).toEqual([
        expect.objectContaining({ engine: 'claude', ok: false }),
        expect.objectContaining({ engine: 'codex', ok: true }),
      ]);
      expect(session?.routingTrace?.selectedEngine).toBe('codex');
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

    it('should compute per-turn usage deltas in sendMessage', async () => {
      const usageAfterSend1 = { costUsd: 0.10, tokenCount: { input: 100, output: 50, cachedInput: 10, total: 160 } };
      const usageAfterSend2 = { costUsd: 0.25, tokenCount: { input: 250, output: 120, cachedInput: 30, total: 400 } };

      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      await manager.startSession({ name: 'turn-test' });

      // Get the engine instance's send mock to update usage on call
      const record = (manager as any).sessions.get('turn-test');
      record.engineInstance.send = vi.fn()
        .mockImplementationOnce(async () => {
          hoisted.claudeUsageRef.current = usageAfterSend1;
          return 'response-1';
        })
        .mockImplementationOnce(async () => {
          hoisted.claudeUsageRef.current = usageAfterSend2;
          return 'response-2';
        });

      const result1 = await manager.sendMessage('turn-test', 'hello');
      expect(result1.turnUsage).toEqual({
        tokensIn: 100,
        tokensOut: 50,
        cachedTokens: 10,
        totalTokens: 160,
        costUsd: 0.1,
        durationMs: expect.any(Number),
      });

      const result2 = await manager.sendMessage('turn-test', 'again');
      expect(result2.turnUsage).toEqual({
        tokensIn: 150,
        tokensOut: 70,
        cachedTokens: 20,
        totalTokens: 240,
        costUsd: 0.15,
        durationMs: expect.any(Number),
      });

      // Session totals should reflect the accumulated values
      expect(result2.session.costUsd).toBe(0.25);
      expect(result2.session.tokenCount.input).toBe(250);

      // Restore default usage
      hoisted.claudeUsageRef.current = hoisted.idleUsage;
    });

    it('should prefer a resume-capable engine when resuming without explicit model or engine', async () => {
      const manager = new SessionManager({
        defaultEngine: 'codex',
        defaultFallbackChain: ['codex', 'claude', 'grok'],
        claude: { model: 'claude-opus-4-6' },
        codex: { model: 'gpt-5.4' },
      });

      await manager.startSession({
        name: 'resume-test',
        resumeSessionId: 'abc123',
      });

      expect(claudeStart).toHaveBeenCalledTimes(1);
      expect(codexStart).not.toHaveBeenCalled();

      const session = manager.getSessionStatus('resume-test');
      expect(session?.engine).toBe('claude');
      expect(session?.routingTrace?.primary.engine).toBe('claude');
    });
  });

  describe('event timeline', () => {
    it('should emit session_started on successful start', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      const spy = vi.spyOn(manager.events, 'appendEvent').mockImplementation(() => {});
      await manager.startSession({ name: 'ev-start' });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_started', sessionName: 'ev-start', engine: 'claude' }),
      );
      spy.mockRestore();
    });

    it('should emit message_sent and message_completed on send', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      await manager.startSession({ name: 'ev-send' });
      const record = (manager as any).sessions.get('ev-send');
      record.engineInstance.send = vi.fn().mockResolvedValue('ok');

      const spy = vi.spyOn(manager.events, 'appendEvent').mockImplementation(() => {});
      await manager.sendMessage('ev-send', 'hello');

      const types = spy.mock.calls.map((c) => (c[0] as any).type);
      expect(types).toContain('message_sent');
      expect(types).toContain('message_completed');
      spy.mockRestore();
    });

    it('should emit message_failed when send throws', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      await manager.startSession({ name: 'ev-fail' });
      const record = (manager as any).sessions.get('ev-fail');
      record.engineInstance.send = vi.fn().mockRejectedValue(new Error('boom'));

      const spy = vi.spyOn(manager.events, 'appendEvent').mockImplementation(() => {});
      await expect(manager.sendMessage('ev-fail', 'hello')).rejects.toThrow();

      const types = spy.mock.calls.map((c) => (c[0] as any).type);
      expect(types).toContain('message_sent');
      expect(types).toContain('message_failed');
      expect(types).not.toContain('message_completed');
      spy.mockRestore();
    });

    it('should emit session_stopped on stop', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      await manager.startSession({ name: 'ev-stop' });

      const spy = vi.spyOn(manager.events, 'appendEvent').mockImplementation(() => {});
      await manager.stopSession('ev-stop');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_stopped', sessionName: 'ev-stop' }),
      );
      spy.mockRestore();
    });

    it('should emit compact_started and compact_completed on compact', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      await manager.startSession({ name: 'ev-compact' });
      const record = (manager as any).sessions.get('ev-compact');
      record.engineInstance.compact = vi.fn().mockResolvedValue('compacted');

      const spy = vi.spyOn(manager.events, 'appendEvent').mockImplementation(() => {});
      await manager.compactSession('ev-compact');

      const types = spy.mock.calls.map((c) => (c[0] as any).type);
      expect(types).toContain('compact_started');
      expect(types).toContain('compact_completed');
      spy.mockRestore();
    });
  });

  describe('activity fields', () => {
    it('should track phase, lastAction, and previews through the session lifecycle', async () => {
      const manager = new SessionManager({
        claude: { model: 'claude-opus-4-6' },
      });

      // After start: phase=idle, lastAction=start
      await manager.startSession({ name: 'activity-test' });
      const afterStart = manager.getSessionStatus('activity-test')!;
      expect(afterStart.activity.phase).toBe('idle');
      expect(afterStart.activity.lastAction).toBe('start');
      expect(afterStart.activity.isRehydrated).toBe(false);
      expect(afterStart.activity.lastPromptPreview).toBeNull();
      expect(afterStart.activity.lastResponsePreview).toBeNull();
      expect(afterStart.activity.updatedAt).toBeInstanceOf(Date);

      // After send: phase=idle, lastAction=send, previews populated
      const record = (manager as any).sessions.get('activity-test');
      record.engineInstance.send = vi.fn().mockResolvedValue('engine reply here');

      const sendResult = await manager.sendMessage('activity-test', 'hello world');
      expect(sendResult.session.activity.phase).toBe('idle');
      expect(sendResult.session.activity.lastAction).toBe('send');
      expect(sendResult.session.activity.lastPromptPreview).toBe('hello world');
      expect(sendResult.session.activity.lastResponsePreview).toBe('engine reply here');

      // Preview truncation at 120 chars
      const longMessage = 'x'.repeat(200);
      record.engineInstance.send = vi.fn().mockResolvedValue('y'.repeat(200));
      const longResult = await manager.sendMessage('activity-test', longMessage);
      expect(longResult.session.activity.lastPromptPreview).toBe('x'.repeat(120) + '…');
      expect(longResult.session.activity.lastResponsePreview).toBe('y'.repeat(120) + '…');
    });
  });
});
