import { describe, it, expect } from 'vitest';

import { createPipelineWorkflow, createFanOutFanInWorkflow, createAutoresearchWorkflow } from '../orchestration/workflow-templates.js';

describe('createPipelineWorkflow', () => {
  it('should create a linear dependency chain', () => {
    const wf = createPipelineWorkflow('p1', 'Pipeline', 'ws', [
      { id: 's1', sessionName: 'sess-1', task: 'step 1' },
      { id: 's2', sessionName: 'sess-2', task: 'step 2' },
      { id: 's3', sessionName: 'sess-3', task: 'step 3' },
    ]);

    expect(wf.id).toBe('p1');
    expect(wf.steps).toHaveLength(3);
    expect(wf.steps[0].dependsOn).toBeUndefined();
    expect(wf.steps[1].dependsOn).toEqual(['s1']);
    expect(wf.steps[2].dependsOn).toEqual(['s2']);
  });

  it('should preserve role and engine on steps', () => {
    const wf = createPipelineWorkflow('p2', 'Pipeline', 'ws', [
      { id: 's1', sessionName: 'sess-1', task: 'step 1', role: 'architect', engine: 'claude' },
    ]);

    expect(wf.steps[0].role).toBe('architect');
    expect(wf.steps[0].engine).toBe('claude');
  });
});

describe('createFanOutFanInWorkflow', () => {
  it('should create parallel fan-out steps and aggregator', () => {
    const wf = createFanOutFanInWorkflow(
      'f1',
      'Fan-Out',
      'ws',
      [
        { id: 'a', sessionName: 'sess-a', task: 'parallel A' },
        { id: 'b', sessionName: 'sess-b', task: 'parallel B' },
        { id: 'c', sessionName: 'sess-c', task: 'parallel C' },
      ],
      { id: 'agg', sessionName: 'sess-agg', task: 'aggregate' },
    );

    expect(wf.steps).toHaveLength(4);

    // Fan-out steps have no dependencies
    expect(wf.steps[0].dependsOn).toBeUndefined();
    expect(wf.steps[1].dependsOn).toBeUndefined();
    expect(wf.steps[2].dependsOn).toBeUndefined();

    // Aggregator depends on all fan-out steps
    const agg = wf.steps[3];
    expect(agg.id).toBe('agg');
    expect(agg.dependsOn).toEqual(['a', 'b', 'c']);
  });
});

describe('createAutoresearchWorkflow', () => {
  it('should create a plan → implement → review → analyze pipeline', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar1', name: 'Test Research', workspace: 'ws',
      objective: 'Investigate X',
    });
    expect(wf.steps).toHaveLength(4);
    expect(wf.steps.map(s => s.id)).toEqual(['plan', 'implement', 'review', 'analyze']);
    expect(wf.steps[0].role).toBe('researcher');
    expect(wf.steps[1].role).toBe('implementer');
    expect(wf.steps[2].role).toBe('reviewer');
    expect(wf.steps[3].role).toBe('analyst');
    expect(wf.steps[3].loop).toBeDefined();
    expect(wf.steps[3].loop!.maxIterations).toBe(5);
    expect(wf.steps[3].loop!.continueCondition).toBe('CONTINUE');
  });

  it('should support parallel experiments', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar2', name: 'Parallel Research', workspace: 'ws',
      objective: 'Test', parallelExperiments: 3,
    });
    expect(wf.steps).toHaveLength(6); // plan + 3 implement + review + analyze
    expect(wf.steps[1].id).toBe('implement-0');
    expect(wf.steps[2].id).toBe('implement-1');
    expect(wf.steps[3].id).toBe('implement-2');
    // Review depends on all implements
    expect(wf.steps[4].dependsOn).toEqual(['implement-0', 'implement-1', 'implement-2']);
  });

  it('should respect custom maxIterations', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar3', name: 'Custom', workspace: 'ws',
      objective: 'Test', maxIterations: 10,
    });
    expect(wf.steps.find(s => s.id === 'analyze')!.loop!.maxIterations).toBe(10);
  });

  it('should apply engine overrides', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar4', name: 'Engines', workspace: 'ws',
      objective: 'Test',
      researcherEngine: 'claude',
      implementerEngine: 'codex',
      reviewerEngine: 'claude',
      analystEngine: 'grok',
    });
    expect(wf.steps.find(s => s.id === 'plan')!.engine).toBe('claude');
    expect(wf.steps.find(s => s.id === 'implement')!.engine).toBe('codex');
    expect(wf.steps.find(s => s.id === 'review')!.engine).toBe('claude');
    expect(wf.steps.find(s => s.id === 'analyze')!.engine).toBe('grok');
  });

  it('should include objective in plan task', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar5', name: 'Obj', workspace: 'ws',
      objective: 'Find the best sorting algorithm',
    });
    expect(wf.steps[0].task).toContain('Find the best sorting algorithm');
  });

  it('should set description on the workflow', () => {
    const wf = createAutoresearchWorkflow({
      id: 'ar6', name: 'Desc', workspace: 'ws',
      objective: 'Research topic',
    });
    expect(wf.description).toContain('Research topic');
  });
});
