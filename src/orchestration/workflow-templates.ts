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

/* ── Autoresearch Template ───────────────────────────────────── */

export interface AutoresearchConfig {
  id: string;
  name: string;
  workspace: string;
  objective: string;
  maxIterations?: number;
  parallelExperiments?: number;
  researcherEngine?: EngineKind;
  implementerEngine?: EngineKind;
  reviewerEngine?: EngineKind;
  analystEngine?: EngineKind;
}

/**
 * Creates an autoresearch workflow: plan → implement[0..N] → review → analyze (loop).
 *
 * The analyst step has a loop config with `continueCondition='CONTINUE'` so it
 * can iteratively refine its synthesis up to `maxIterations` times. Each
 * iteration the analyst sees accumulated context from the blackboard.
 *
 * When `parallelExperiments > 1`, multiple implement steps run in parallel
 * and the review step depends on all of them.
 */
export function createAutoresearchWorkflow(config: AutoresearchConfig): WorkflowDefinition {
  const maxIterations = config.maxIterations ?? 5;
  const parallelExperiments = config.parallelExperiments ?? 1;

  const steps: WorkflowStepDefinition[] = [];

  // Step 1: Plan — researcher generates hypotheses and experiment plan
  steps.push({
    id: 'plan',
    sessionName: `${config.id}-plan`,
    role: 'researcher',
    engine: config.researcherEngine,
    task:
      `Research objective: ${config.objective}\n\n` +
      'Generate hypotheses and design an experiment plan to investigate this objective. ' +
      'Structure your output with clear hypotheses, methodology, and expected outcomes.',
  });

  // Steps 2..N+1: Implement (experiments, optionally parallel)
  const implementIds: string[] = [];
  for (let i = 0; i < parallelExperiments; i++) {
    const id = parallelExperiments === 1 ? 'implement' : `implement-${i}`;
    implementIds.push(id);
    steps.push({
      id,
      sessionName: `${config.id}-${id}`,
      role: 'implementer',
      engine: config.implementerEngine,
      task: 'Execute the experiment plan from the research phase. Implement thoroughly and report results with data.',
      dependsOn: ['plan'],
    });
  }

  // Step N+2: Review
  steps.push({
    id: 'review',
    sessionName: `${config.id}-review`,
    role: 'reviewer',
    engine: config.reviewerEngine,
    task: 'Review the experiment results. Assess methodology, validity, completeness, and identify gaps or issues.',
    dependsOn: implementIds,
  });

  // Step N+3: Analyze (with loop)
  steps.push({
    id: 'analyze',
    sessionName: `${config.id}-analyze`,
    role: 'analyst',
    engine: config.analystEngine,
    task:
      'Evaluate the research findings and review feedback. ' +
      'Determine if the research objective has been adequately addressed.\n\n' +
      'If more analysis or refinement is needed, output CONTINUE on its own line.\n' +
      'If the research is complete and findings are sufficient, output DONE on its own line followed by a final synthesis.',
    dependsOn: ['review'],
    loop: {
      maxIterations,
      continueCondition: 'CONTINUE',
    },
  });

  return {
    id: config.id,
    name: config.name,
    description: `Autoresearch workflow: ${config.objective}`,
    workspace: config.workspace,
    steps,
  };
}
