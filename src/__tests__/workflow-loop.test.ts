import { describe, it, expect, vi } from 'vitest';
import { evaluateLoopCondition } from '../orchestration/loop-evaluator.js';
import type { LoopConfig } from '../orchestration/workflow-types.js';
import type { LoopEvaluationContext } from '../orchestration/loop-evaluator.js';

vi.mock('../orchestration/workflow-store.js', () => ({
  WorkflowStore: class {
    private data: Record<string, unknown> = {};
    load() { return { version: 1, workflows: this.data }; }
    save() {}
    upsert(w: { id: string }) { this.data[w.id] = w; }
    get(id: string) { return this.data[id]; }
    list() { return Object.values(this.data); }
    clear() { this.data = {}; }
  },
}));

import { validateWorkflow, WorkflowEngine } from '../orchestration/workflow-engine.js';
import type { WorkflowDefinition } from '../orchestration/workflow-types.js';
import type { SessionManager } from '../session-manager.js';

/* ── evaluateLoopCondition unit tests ─────────────────────────── */

describe('evaluateLoopCondition', () => {
  it('should stop when iteration >= maxIterations', () => {
    const config: LoopConfig = { maxIterations: 3 };
    const ctx: LoopEvaluationContext = { output: '', iteration: 3, blackboard: {} };
    expect(evaluateLoopCondition(config, ctx)).toBe(false);
  });

  it('should stop when iteration exceeds maxIterations', () => {
    const config: LoopConfig = { maxIterations: 2 };
    const ctx: LoopEvaluationContext = { output: '', iteration: 5, blackboard: {} };
    expect(evaluateLoopCondition(config, ctx)).toBe(false);
  });

  it('should continue when iteration < maxIterations and no condition', () => {
    const config: LoopConfig = { maxIterations: 5 };
    const ctx: LoopEvaluationContext = { output: '', iteration: 2, blackboard: {} };
    expect(evaluateLoopCondition(config, ctx)).toBe(true);
  });

  it('should continue when continueCondition string is found in output', () => {
    const config: LoopConfig = { maxIterations: 10, continueCondition: 'CONTINUE' };
    const ctx: LoopEvaluationContext = {
      output: 'Result: CONTINUE processing',
      iteration: 1,
      blackboard: {},
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(true);
  });

  it('should stop when continueCondition string is NOT found in output', () => {
    const config: LoopConfig = { maxIterations: 10, continueCondition: 'CONTINUE' };
    const ctx: LoopEvaluationContext = {
      output: 'DONE with all tasks',
      iteration: 1,
      blackboard: {},
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(false);
  });

  it('should continue when convergence delta exceeds threshold', () => {
    const config: LoopConfig = {
      maxIterations: 20,
      convergenceKey: 'score',
      convergenceThreshold: 0.01,
    };
    const ctx: LoopEvaluationContext = {
      output: '',
      iteration: 3,
      blackboard: { score_current: 0.85, score_previous: 0.70 },
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(true);
  });

  it('should stop when convergence delta is within threshold', () => {
    const config: LoopConfig = {
      maxIterations: 20,
      convergenceKey: 'score',
      convergenceThreshold: 0.01,
    };
    const ctx: LoopEvaluationContext = {
      output: '',
      iteration: 5,
      blackboard: { score_current: 0.952, score_previous: 0.949 },
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(false);
  });

  it('should continue when convergence data is not yet available', () => {
    const config: LoopConfig = {
      maxIterations: 20,
      convergenceKey: 'score',
      convergenceThreshold: 0.01,
    };
    const ctx: LoopEvaluationContext = {
      output: '',
      iteration: 1,
      blackboard: {},
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(true);
  });

  it('should respect maxIterations even with continueCondition match', () => {
    const config: LoopConfig = { maxIterations: 2, continueCondition: 'CONTINUE' };
    const ctx: LoopEvaluationContext = {
      output: 'CONTINUE',
      iteration: 2,
      blackboard: {},
    };
    expect(evaluateLoopCondition(config, ctx)).toBe(false);
  });
});

/* ── validateWorkflow with loop mode ──────────────────────────── */

describe('validateWorkflow loop mode', () => {
  it('should still reject cycles in default (dag) mode', () => {
    const def: WorkflowDefinition = {
      id: 'wf-dag-cycle',
      name: 'DAG Cycle',
      workspace: 'ws',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'A', dependsOn: ['s2'] },
        { id: 's2', sessionName: 'sess-2', task: 'B', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('cycle');
  });

  it('should reject cycles in explicit dag mode', () => {
    const def: WorkflowDefinition = {
      id: 'wf-dag-cycle-explicit',
      name: 'DAG Cycle Explicit',
      workspace: 'ws',
      mode: 'dag',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'A', dependsOn: ['s2'] },
        { id: 's2', sessionName: 'sess-2', task: 'B', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('cycle');
  });

  it('should allow cycles in loop mode when step has loop guard', () => {
    const def: WorkflowDefinition = {
      id: 'wf-loop-ok',
      name: 'Loop OK',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        {
          id: 's1',
          sessionName: 'sess-1',
          task: 'Generate',
          dependsOn: ['s2'],
          loop: { maxIterations: 5 },
        },
        { id: 's2', sessionName: 'sess-2', task: 'Review', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).not.toThrow();
  });

  it('should reject cycles in loop mode without loop guard', () => {
    const def: WorkflowDefinition = {
      id: 'wf-loop-no-guard',
      name: 'Loop No Guard',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        { id: 's1', sessionName: 'sess-1', task: 'A', dependsOn: ['s2'] },
        { id: 's2', sessionName: 'sess-2', task: 'B', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).toThrow('loop.maxIterations configured');
  });

  it('should accept loop mode with no cycles (DAG-compatible loop workflow)', () => {
    const def: WorkflowDefinition = {
      id: 'wf-loop-no-cycle',
      name: 'Loop No Cycle',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        {
          id: 's1',
          sessionName: 'sess-1',
          task: 'Iterate',
          loop: { maxIterations: 3 },
        },
        { id: 's2', sessionName: 'sess-2', task: 'Finalize', dependsOn: ['s1'] },
      ],
    };
    expect(() => validateWorkflow(def)).not.toThrow();
  });
});

/* ── Loop execution integration test ─────────────────────────── */

describe('WorkflowEngine loop execution', () => {
  it('should run a loop step multiple iterations until condition fails', async () => {
    const mockManager = {
      startSession: vi.fn().mockResolvedValue({
        name: 'loop-step',
        engine: 'claude',
        model: 'test',
        state: 'running',
        costUsd: 0,
        tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
        createdAt: new Date().toISOString(),
      }),
      sendMessage: vi.fn()
        .mockResolvedValueOnce({
          name: 'loop-step',
          output: 'CONTINUE result 1',
          session: {},
          turnUsage: {
            tokensIn: 10, tokensOut: 20, cachedTokens: 0,
            totalTokens: 30, costUsd: 0.001, durationMs: 100,
          },
        })
        .mockResolvedValueOnce({
          name: 'loop-step',
          output: 'CONTINUE result 2',
          session: {},
          turnUsage: {
            tokensIn: 10, tokensOut: 20, cachedTokens: 0,
            totalTokens: 30, costUsd: 0.001, durationMs: 100,
          },
        })
        .mockResolvedValueOnce({
          name: 'loop-step',
          output: 'DONE final',
          session: {},
          turnUsage: {
            tokensIn: 10, tokensOut: 20, cachedTokens: 0,
            totalTokens: 30, costUsd: 0.001, durationMs: 100,
          },
        }),
      setContext: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;

    const engine = new WorkflowEngine();

    const def: WorkflowDefinition = {
      id: 'wf-loop-exec',
      name: 'Loop Execution Test',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        {
          id: 'loop-step',
          sessionName: 'loop-sess',
          task: 'Process data',
          loop: { maxIterations: 5, continueCondition: 'CONTINUE' },
        },
      ],
    };

    await engine.start(def, mockManager);

    // Wait for async execution to complete
    await new Promise(r => setTimeout(r, 500));

    const status = engine.getStatus('wf-loop-exec');
    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');

    // The step should have been called 3 times:
    // iteration 1 → output contains CONTINUE → reset to pending → run again
    // iteration 2 → output contains CONTINUE → reset to pending → run again
    // iteration 3 → output is 'DONE final' → no CONTINUE → stop
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(3);

    // Final iteration count should be 3 (incremented on each completion)
    expect(status!.steps['loop-step'].iteration).toBe(3);
    expect(status!.steps['loop-step'].status).toBe('completed');
    expect(status!.steps['loop-step'].output).toBe('DONE final');
  });

  it('should stop at maxIterations even if continueCondition matches', async () => {
    const mockManager = {
      startSession: vi.fn().mockResolvedValue({
        name: 'max-step',
        engine: 'claude',
        model: 'test',
        state: 'running',
        costUsd: 0,
        tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
        createdAt: new Date().toISOString(),
      }),
      sendMessage: vi.fn().mockResolvedValue({
        name: 'max-step',
        output: 'CONTINUE always',
        session: {},
        turnUsage: {
          tokensIn: 10, tokensOut: 20, cachedTokens: 0,
          totalTokens: 30, costUsd: 0.001, durationMs: 100,
        },
      }),
      setContext: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;

    const engine = new WorkflowEngine();

    const def: WorkflowDefinition = {
      id: 'wf-loop-max',
      name: 'Max Iterations Test',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        {
          id: 'max-step',
          sessionName: 'max-sess',
          task: 'Infinite loop guard',
          loop: { maxIterations: 3, continueCondition: 'CONTINUE' },
        },
      ],
    };

    await engine.start(def, mockManager);
    await new Promise(r => setTimeout(r, 500));

    const status = engine.getStatus('wf-loop-max');
    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');

    // Should have been called exactly 3 times (maxIterations)
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(3);
    expect(status!.steps['max-step'].iteration).toBe(3);
  });

  it('should reset downstream steps when a loop step resets', async () => {
    let callCount = 0;
    const mockManager = {
      startSession: vi.fn().mockResolvedValue({
        name: 'test',
        engine: 'claude',
        model: 'test',
        state: 'running',
        costUsd: 0,
        tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
        createdAt: new Date().toISOString(),
      }),
      sendMessage: vi.fn().mockImplementation(async (name: string) => {
        callCount++;
        const output = name === 'gen-sess'
          ? (callCount <= 2 ? 'CONTINUE draft' : 'DONE final draft')
          : `Review of call ${callCount}`;
        return {
          name,
          output,
          session: {},
          turnUsage: {
            tokensIn: 10, tokensOut: 20, cachedTokens: 0,
            totalTokens: 30, costUsd: 0.001, durationMs: 100,
          },
        };
      }),
      setContext: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;

    const engine = new WorkflowEngine();

    const def: WorkflowDefinition = {
      id: 'wf-loop-downstream',
      name: 'Loop Downstream Reset',
      workspace: 'ws',
      mode: 'loop',
      steps: [
        {
          id: 'generate',
          sessionName: 'gen-sess',
          task: 'Generate content',
          loop: { maxIterations: 5, continueCondition: 'CONTINUE' },
        },
        {
          id: 'review',
          sessionName: 'rev-sess',
          task: 'Review content',
          dependsOn: ['generate'],
        },
      ],
    };

    await engine.start(def, mockManager);
    await new Promise(r => setTimeout(r, 1000));

    const status = engine.getStatus('wf-loop-downstream');
    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');

    // The generate step ran multiple times, and so did the review step
    // (review was reset to pending each time generate looped)
    expect(status!.steps['generate'].iteration).toBe(3);
    expect(status!.steps['generate'].status).toBe('completed');
    expect(status!.steps['review'].status).toBe('completed');
  });
});
