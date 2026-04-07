import { describe, it, expect } from 'vitest';

import { createPipelineWorkflow, createFanOutFanInWorkflow } from '../orchestration/workflow-templates.js';

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
