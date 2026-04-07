import type { WorkflowDefinition, WorkflowStepDefinition } from './workflow-types.js';
import type { EngineKind } from '../types.js';

export interface PipelineStep {
  id: string;
  sessionName: string;
  task: string;
  role?: string;
  engine?: EngineKind;
  model?: string;
}

export interface FanOutStep {
  id: string;
  sessionName: string;
  task: string;
  role?: string;
  engine?: EngineKind;
  model?: string;
}

export interface FanInStep {
  id: string;
  sessionName: string;
  task: string;
  role?: string;
  engine?: EngineKind;
  model?: string;
}

/**
 * Creates a linear pipeline workflow: step[0] → step[1] → step[2] → ...
 * Each step depends on the previous one.
 */
export function createPipelineWorkflow(
  id: string,
  name: string,
  workspace: string,
  steps: PipelineStep[],
): WorkflowDefinition {
  const workflowSteps: WorkflowStepDefinition[] = steps.map((step, index) => ({
    id: step.id,
    sessionName: step.sessionName,
    task: step.task,
    role: step.role,
    engine: step.engine,
    model: step.model,
    dependsOn: index > 0 ? [steps[index - 1].id] : undefined,
  }));

  return { id, name, workspace, steps: workflowSteps };
}

/**
 * Creates a fan-out/fan-in workflow:
 * All fanOutSteps run in parallel (no dependencies).
 * The fanInStep depends on all fanOutSteps.
 */
export function createFanOutFanInWorkflow(
  id: string,
  name: string,
  workspace: string,
  fanOutSteps: FanOutStep[],
  fanInStep: FanInStep,
): WorkflowDefinition {
  const parallelSteps: WorkflowStepDefinition[] = fanOutSteps.map(step => ({
    id: step.id,
    sessionName: step.sessionName,
    task: step.task,
    role: step.role,
    engine: step.engine,
    model: step.model,
  }));

  const aggregatorStep: WorkflowStepDefinition = {
    id: fanInStep.id,
    sessionName: fanInStep.sessionName,
    task: fanInStep.task,
    role: fanInStep.role,
    engine: fanInStep.engine,
    model: fanInStep.model,
    dependsOn: fanOutSteps.map(s => s.id),
  };

  return { id, name, workspace, steps: [...parallelSteps, aggregatorStep] };
}
