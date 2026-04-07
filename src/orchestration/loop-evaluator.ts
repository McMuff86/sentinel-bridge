import type { LoopConfig } from './workflow-types.js';

export interface LoopEvaluationContext {
  output: string;
  iteration: number;
  blackboard: Record<string, unknown>;
}

/**
 * Evaluate whether a loop step should continue iterating.
 * Returns true if the loop should CONTINUE (run another iteration).
 */
export function evaluateLoopCondition(
  config: LoopConfig,
  context: LoopEvaluationContext,
): boolean {
  // Check maxIterations first — hard stop
  if (context.iteration >= config.maxIterations) return false;

  // String-based condition: continue if output includes the string
  if (config.continueCondition) {
    return context.output.includes(config.continueCondition);
  }

  // Convergence-based: check if value has converged
  if (config.convergenceKey && config.convergenceThreshold != null) {
    const currentValue = context.blackboard[`${config.convergenceKey}_current`];
    const previousValue = context.blackboard[`${config.convergenceKey}_previous`];
    if (typeof currentValue === 'number' && typeof previousValue === 'number') {
      const delta = Math.abs(currentValue - previousValue);
      return delta > config.convergenceThreshold; // continue if NOT converged
    }
    return true; // not enough data yet, continue
  }

  // No condition specified — just run maxIterations times
  return context.iteration < config.maxIterations;
}
