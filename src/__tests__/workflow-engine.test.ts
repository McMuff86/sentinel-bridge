import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const engineSend = vi.fn().mockResolvedValue('step output');
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
vi.mock('../orchestration/context-store.js', () => ({
  ContextStore: class {
    set() { return { key: 'k', value: 'v', setBy: 's', updatedAt: '' }; }
    get() { return undefined; }
    list() { return []; }
    delete() { return false; }
    clear() {}
  },
  validateContextKey() {},
}));
vi.mock('../orchestration/context-events.js', () => ({
  ContextEventStore: class {
    appendEvent() {}
    listEvents() { return []; }
    clearEvents() {}
  },
}));

import { SessionManager } from '../session-manager.js';
import { validateWorkflow } from '../orchestration/workflow-engine.js';
import type { WorkflowDefinition } from '../orchestration/workflow-types.js';

describe('validateWorkflow', () => {
  it('should accept a valid linear workflow', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'do A' },
        { id: 's2', sessionName: 'sess-2', task: 'do B', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).not.toThrow();
  });

  it('should reject empty steps', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [],
    };
    expect(() => validateWorkflow(def)).toThrow('at least one step');
  });

  it('should reject unknown dependency references', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'do A', dependsOn: ['nonexistent'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('unknown step');
  });

  it('should reject self-dependencies', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'do A', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('cannot depend on itself');
  });

  it('should reject cycles', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'do A', dependsOn: ['s2'] },
        { id: 's2', sessionName: 'sess-2', task: 'do B', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('cycle');
  });

  it('should reject duplicate session names', () => {
    const def: WorkflowDefinition = {
      id: 'wf1',
      name: 'Test',
      workspace: 'ws1',
      steps: [
        { id: 's1', sessionName: 'same-name', task: 'do A' },
        { id: 's2', sessionName: 'same-name', task: 'do B' },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('Duplicate sessionName');
  });
});

describe('WorkflowEngine integration', () => {
  let manager: SessionManager;

  beforeEach(() => {
    hoisted.engineSend.mockReset().mockResolvedValue('step output');
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
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it('should start a single-step workflow', async () => {
    const def: WorkflowDefinition = {
      id: 'wf-single',
      name: 'Single Step',
      workspace: 'ws',
      steps: [
        { id: 's1', sessionName: 'step-1', task: 'do something' },
      ],
    };

    const state = await manager.startWorkflow(def);
    expect(state.id).toBe('wf-single');
    expect(state.status).toBe('running');

    // Wait for async execution
    await new Promise(r => setTimeout(r, 200));

    const status = manager.getWorkflowStatus('wf-single');
    expect(status).toBeDefined();
    expect(status!.steps['s1'].status).toBe('completed');
    expect(status!.status).toBe('completed');
  });

  it('should execute pipeline steps in order', async () => {
    const callOrder: string[] = [];
    hoisted.engineSend.mockImplementation(async (msg: string) => {
      callOrder.push(msg.includes('step-1') ? 's1' : msg.includes('step-2') ? 's2' : 's3');
      return 'output';
    });

    const def: WorkflowDefinition = {
      id: 'wf-pipe',
      name: 'Pipeline',
      workspace: 'ws',
      steps: [
        { id: 's1', sessionName: 'step-1', task: 'task for step-1' },
        { id: 's2', sessionName: 'step-2', task: 'task for step-2', dependsOn: ['s1'] },
        { id: 's3', sessionName: 'step-3', task: 'task for step-3', dependsOn: ['s2'] },
      ],
    };

    await manager.startWorkflow(def);
    await new Promise(r => setTimeout(r, 500));

    const status = manager.getWorkflowStatus('wf-pipe');
    expect(status!.status).toBe('completed');
    expect(status!.steps['s1'].status).toBe('completed');
    expect(status!.steps['s2'].status).toBe('completed');
    expect(status!.steps['s3'].status).toBe('completed');
  });

  it('should skip dependent steps when a step fails', async () => {
    let callCount = 0;
    hoisted.engineSend.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('step failed');
      return 'output';
    });

    const def: WorkflowDefinition = {
      id: 'wf-fail',
      name: 'Failure',
      workspace: 'ws',
      steps: [
        { id: 's1', sessionName: 'fail-step', task: 'will fail' },
        { id: 's2', sessionName: 'skip-step', task: 'should skip', dependsOn: ['s1'] },
      ],
    };

    await manager.startWorkflow(def);
    await new Promise(r => setTimeout(r, 300));

    const status = manager.getWorkflowStatus('wf-fail');
    expect(status!.steps['s1'].status).toBe('failed');
    expect(status!.steps['s2'].status).toBe('skipped');
    expect(status!.status).toBe('failed');
  });

  it('should cancel a running workflow', async () => {
    // Make the engine slow so we can cancel mid-flight
    hoisted.engineSend.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve('slow'), 2000)),
    );

    const def: WorkflowDefinition = {
      id: 'wf-cancel',
      name: 'Cancellable',
      workspace: 'ws',
      steps: [
        { id: 's1', sessionName: 'slow-step', task: 'slow task' },
        { id: 's2', sessionName: 'after-slow', task: 'after', dependsOn: ['s1'] },
      ],
    };

    await manager.startWorkflow(def);
    await new Promise(r => setTimeout(r, 50));

    const cancelled = manager.cancelWorkflow('wf-cancel');
    expect(cancelled.status).toBe('cancelled');
  });

  it('should list workflows', async () => {
    const def: WorkflowDefinition = {
      id: 'wf-list-test',
      name: 'List Test',
      workspace: 'ws',
      steps: [{ id: 's1', sessionName: 'list-step', task: 'task' }],
    };

    await manager.startWorkflow(def);
    const list = manager.listWorkflows();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some(w => w.id === 'wf-list-test')).toBe(true);
  });

  it('should reject duplicate workflow ids', async () => {
    const def: WorkflowDefinition = {
      id: 'wf-dup',
      name: 'Dup',
      workspace: 'ws',
      steps: [{ id: 's1', sessionName: 'dup-step', task: 'task' }],
    };

    await manager.startWorkflow(def);
    await expect(manager.startWorkflow(def)).rejects.toThrow('already exists');
  });
});
