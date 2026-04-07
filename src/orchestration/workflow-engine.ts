import type { SessionManager } from '../session-manager.js';
import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowStepState,
} from './workflow-types.js';

/**
 * Detect cycles in a directed graph using DFS.
 * Returns the first cycle found as an array of step ids, or null.
 */
function detectCycle(steps: WorkflowDefinition['steps']): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const adjMap = new Map<string, string[]>();

  for (const step of steps) {
    color.set(step.id, WHITE);
    adjMap.set(step.id, step.dependsOn ?? []);
  }

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    for (const v of adjMap.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        // Back edge found — reconstruct cycle
        const cycle = [v, u];
        let cur = u;
        while (cur !== v) {
          cur = parent.get(cur) ?? v;
          if (cur !== v) cycle.push(cur);
        }
        return cycle.reverse();
      }
      if (color.get(v) === WHITE) {
        parent.set(v, u);
        const result = dfs(v);
        if (result) return result;
      }
    }
    color.set(u, BLACK);
    return null;
  }

  for (const step of steps) {
    if (color.get(step.id) === WHITE) {
      parent.set(step.id, null);
      const cycle = dfs(step.id);
      if (cycle) return cycle;
    }
  }

  return null;
}

export function validateWorkflow(definition: WorkflowDefinition): void {
  if (!definition.id) {
    throw new Error('Workflow id is required.');
  }
  if (!definition.steps || definition.steps.length === 0) {
    throw new Error('Workflow must have at least one step.');
  }

  const stepIds = new Set(definition.steps.map(s => s.id));
  const sessionNames = new Set<string>();

  for (const step of definition.steps) {
    if (!step.id) throw new Error('Each workflow step must have an id.');
    if (!step.sessionName) throw new Error(`Step "${step.id}" must have a sessionName.`);
    if (!step.task) throw new Error(`Step "${step.id}" must have a task.`);

    if (sessionNames.has(step.sessionName)) {
      throw new Error(`Duplicate sessionName "${step.sessionName}" in workflow. Each step must use a unique session name.`);
    }
    sessionNames.add(step.sessionName);

    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        throw new Error(`Step "${step.id}" depends on unknown step "${dep}".`);
      }
      if (dep === step.id) {
        throw new Error(`Step "${step.id}" cannot depend on itself.`);
      }
    }
  }

  const cycle = detectCycle(definition.steps);
  if (cycle) {
    throw new Error(`Workflow contains a cycle: ${cycle.join(' → ')}.`);
  }
}

function createInitialState(definition: WorkflowDefinition): WorkflowState {
  const now = new Date().toISOString();
  const steps: Record<string, WorkflowStepState> = {};

  for (const step of definition.steps) {
    steps[step.id] = {
      id: step.id,
      status: 'pending',
      sessionName: step.sessionName,
    };
  }

  return {
    id: definition.id,
    definition,
    status: 'pending',
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

function getReadySteps(
  definition: WorkflowDefinition,
  state: WorkflowState,
): WorkflowDefinition['steps'] {
  return definition.steps.filter(step => {
    const stepState = state.steps[step.id];
    if (!stepState || stepState.status !== 'pending') return false;
    // All dependencies must be completed
    return (step.dependsOn ?? []).every(
      dep => state.steps[dep]?.status === 'completed',
    );
  });
}

function markDependentsSkipped(
  failedStepId: string,
  definition: WorkflowDefinition,
  state: WorkflowState,
): void {
  // Find all steps that transitively depend on the failed step
  const toSkip = new Set<string>();
  const queue = [failedStepId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of definition.steps) {
      if (toSkip.has(step.id)) continue;
      if ((step.dependsOn ?? []).includes(current)) {
        toSkip.add(step.id);
        queue.push(step.id);
      }
    }
  }

  for (const id of toSkip) {
    const stepState = state.steps[id];
    if (stepState && stepState.status === 'pending') {
      stepState.status = 'skipped';
    }
  }
}

export class WorkflowEngine {
  private readonly workflows = new Map<string, WorkflowState>();

  async start(
    definition: WorkflowDefinition,
    manager: SessionManager,
  ): Promise<WorkflowState> {
    validateWorkflow(definition);

    if (this.workflows.has(definition.id)) {
      throw new Error(`Workflow "${definition.id}" already exists.`);
    }

    const state = createInitialState(definition);
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    this.workflows.set(definition.id, state);

    // Execute the DAG asynchronously — don't await here so the caller gets the initial state
    this.executeDAG(definition, state, manager).catch(error => {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = new Date().toISOString();
    });

    return { ...state, steps: { ...state.steps } };
  }

  getStatus(id: string): WorkflowState | undefined {
    const state = this.workflows.get(id);
    if (!state) return undefined;
    return { ...state, steps: { ...state.steps } };
  }

  cancel(id: string): WorkflowState {
    const state = this.workflows.get(id);
    if (!state) throw new Error(`Workflow "${id}" not found.`);

    state.status = 'cancelled';
    state.updatedAt = new Date().toISOString();

    // Mark pending steps as skipped
    for (const stepState of Object.values(state.steps)) {
      if (stepState.status === 'pending' || stepState.status === 'running') {
        stepState.status = 'skipped';
      }
    }

    return { ...state, steps: { ...state.steps } };
  }

  list(): WorkflowState[] {
    return Array.from(this.workflows.values()).map(s => ({
      ...s,
      steps: { ...s.steps },
    }));
  }

  private async executeDAG(
    definition: WorkflowDefinition,
    state: WorkflowState,
    manager: SessionManager,
  ): Promise<void> {
    while (state.status === 'running') {
      const ready = getReadySteps(definition, state);
      if (ready.length === 0) {
        // Check if all steps are done
        const allDone = Object.values(state.steps).every(
          s => s.status !== 'pending' && s.status !== 'running',
        );
        if (allDone) {
          const anyFailed = Object.values(state.steps).some(
            s => s.status === 'failed',
          );
          state.status = anyFailed ? 'failed' : 'completed';
          state.updatedAt = new Date().toISOString();
          return;
        }
        // Steps are still running — wait a tick
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      // Execute ready steps in parallel
      await Promise.allSettled(
        ready.map(step => this.executeStep(step, definition, state, manager)),
      );
    }
  }

  private async executeStep(
    step: WorkflowDefinition['steps'][number],
    definition: WorkflowDefinition,
    state: WorkflowState,
    manager: SessionManager,
  ): Promise<void> {
    const stepState = state.steps[step.id]!;
    stepState.status = 'running';
    stepState.startedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();

    try {
      // Start session for this step
      await manager.startSession({
        name: step.sessionName,
        engine: step.engine,
        model: step.model,
        role: step.role,
      });

      // Build context from upstream outputs
      let taskMessage = step.task;
      const deps = step.dependsOn ?? [];
      if (deps.length > 0) {
        const upstreamContext: string[] = [];
        for (const depId of deps) {
          const depState = state.steps[depId];
          if (depState?.output) {
            upstreamContext.push(`[Output from ${depId}]:\n${depState.output}`);
          }
        }
        if (upstreamContext.length > 0) {
          taskMessage = upstreamContext.join('\n\n') + '\n\n' + step.task;
        }
      }

      // Send the task
      const result = await manager.sendMessage(step.sessionName, taskMessage);

      // Store output in blackboard for downstream steps
      try {
        await manager.setContext(
          definition.workspace,
          `${step.id}.output`,
          result.output,
          step.sessionName,
        );
      } catch {
        // Non-fatal: context store failure doesn't fail the step
      }

      stepState.status = 'completed';
      stepState.output = result.output;
      stepState.turnUsage = result.turnUsage;
      stepState.completedAt = new Date().toISOString();
      state.updatedAt = new Date().toISOString();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      stepState.status = 'failed';
      stepState.error = errMsg;
      stepState.completedAt = new Date().toISOString();
      state.updatedAt = new Date().toISOString();

      // Skip dependent steps
      markDependentsSkipped(step.id, definition, state);
    }
  }
}
