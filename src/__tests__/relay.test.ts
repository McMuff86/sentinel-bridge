import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const engineSend = vi.fn().mockResolvedValue('response');
  const engineStart = vi.fn().mockResolvedValue(undefined);
  const engineStop = vi.fn().mockResolvedValue(undefined);
  const engineCancel = vi.fn();
  const engineCompact = vi.fn().mockResolvedValue('compacted');
  const engineStatus = vi.fn().mockReturnValue({
    state: 'running',
    sessionId: null,
    model: 'test-model',
    usage: {
      costUsd: 0,
      tokenCount: { input: 10, output: 5, cachedInput: 0, total: 15 },
    },
  });
  const engineGetSessionId = vi.fn().mockReturnValue(null);

  class MockEngine {
    send = engineSend;
    start = engineStart;
    stop = engineStop;
    cancel = engineCancel;
    compact = engineCompact;
    status = engineStatus;
    getSessionId = engineGetSessionId;
  }

  return { MockEngine, engineSend, engineStart, engineStop, engineStatus };
});

vi.mock('../engines/claude-engine.js', () => ({
  ClaudeEngine: hoisted.MockEngine,
}));
vi.mock('../engines/codex-engine.js', () => ({
  CodexEngine: hoisted.MockEngine,
}));
vi.mock('../engines/grok-engine.js', () => ({
  GrokEngine: hoisted.MockEngine,
}));
vi.mock('../engines/ollama-engine.js', () => ({
  OllamaEngine: hoisted.MockEngine,
}));

// Mock persistence to avoid filesystem
vi.mock('../sessions/session-store.js', () => ({
  SessionStore: class {
    load() { return { version: 1, sessions: {} }; }
    save() {}
    upsert() {}
    get() { return undefined; }
    delete() {}
    list() { return []; }
    clear() {}
  },
}));
vi.mock('../sessions/session-events.js', () => ({
  SessionEventStore: class {
    appendEvent() {}
    listEvents() { return []; }
    clearEvents() {}
  },
}));
vi.mock('../orchestration/role-store.js', () => ({
  RoleStore: class {
    load() { return { version: 1, roles: {} }; }
    save() {}
    upsert() {}
    get() { return undefined; }
    delete() {}
    list() { return []; }
    clear() {}
  },
}));

import { SessionManager } from '../session-manager.js';

describe('Relay', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    hoisted.engineSend.mockReset().mockResolvedValue('relay response');
    hoisted.engineStart.mockReset().mockResolvedValue(undefined);
    hoisted.engineStop.mockReset().mockResolvedValue(undefined);
    hoisted.engineStatus.mockReset().mockReturnValue({
      state: 'running',
      sessionId: null,
      model: 'test-model',
      usage: {
        costUsd: 0,
        tokenCount: { input: 10, output: 5, cachedInput: 0, total: 15 },
      },
    });

    manager = new SessionManager({ cleanupIntervalMs: 0 });
    await manager.start('agent-a', 'claude', { model: 'claude-opus-4-6' });
    await manager.start('agent-b', 'claude', { model: 'claude-opus-4-6' });
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it('should relay a message from one session to another', async () => {
    const result = await manager.relayMessage('agent-a', 'agent-b', 'hello from A');
    expect(result.from).toBe('agent-a');
    expect(result.to).toBe('agent-b');
    expect(result.message).toBe('hello from A');
    expect(result.sendResult.output).toBe('relay response');
  });

  it('should throw when source session does not exist', async () => {
    await expect(
      manager.relayMessage('nonexistent', 'agent-b', 'msg'),
    ).rejects.toThrow('not found');
  });

  it('should throw when target session does not exist', async () => {
    await expect(
      manager.relayMessage('agent-a', 'nonexistent', 'msg'),
    ).rejects.toThrow('not found');
  });
});

describe('Broadcast', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    hoisted.engineSend.mockReset().mockResolvedValue('broadcast response');
    hoisted.engineStart.mockReset().mockResolvedValue(undefined);
    hoisted.engineStop.mockReset().mockResolvedValue(undefined);
    hoisted.engineStatus.mockReset().mockReturnValue({
      state: 'running',
      sessionId: null,
      model: 'test-model',
      usage: {
        costUsd: 0,
        tokenCount: { input: 10, output: 5, cachedInput: 0, total: 15 },
      },
    });

    manager = new SessionManager({ cleanupIntervalMs: 0 });
    await manager.start('sender', 'claude', { model: 'claude-opus-4-6' });
    await manager.start('recv-1', 'claude', { model: 'claude-opus-4-6' });
    await manager.start('recv-2', 'claude', { model: 'claude-opus-4-6' });
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it('should broadcast to all active sessions except sender', async () => {
    const result = await manager.broadcastMessage('sender', 'hello all');
    expect(result.from).toBe('sender');
    expect(result.targets).toContain('recv-1');
    expect(result.targets).toContain('recv-2');
    expect(result.targets).not.toContain('sender');
    expect(result.results.filter(r => r.ok)).toHaveLength(2);
  });

  it('should exclude specified sessions', async () => {
    const result = await manager.broadcastMessage('sender', 'hello', ['recv-1']);
    expect(result.targets).not.toContain('recv-1');
    expect(result.targets).toContain('recv-2');
  });

  it('should handle partial failures gracefully', async () => {
    // Make send fail for the second call
    hoisted.engineSend
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('engine error'));

    const result = await manager.broadcastMessage('sender', 'hello');
    const succeeded = result.results.filter(r => r.ok);
    const failed = result.results.filter(r => !r.ok);
    expect(succeeded.length + failed.length).toBe(2);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toContain('engine error');
  });
});
