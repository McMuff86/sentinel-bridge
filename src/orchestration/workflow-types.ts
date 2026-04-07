import type { EngineKind, TurnUsage } from '../types.js';

export interface LoopConfig {
  maxIterations: number;
  continueCondition?: string;
  convergenceKey?: string;
  convergenceThreshold?: number;
}

export interface WorkflowStepDefinition {
  id: string;
  sessionName: string;
  role?: string;
  task: string;
  dependsOn?: string[];
  engine?: EngineKind;
  model?: string;
  loop?: LoopConfig;
  condition?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  workspace: string;
  steps: WorkflowStepDefinition[];
  mode?: 'dag' | 'loop';
}

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowStepState {
  id: string;
  status: WorkflowStepStatus;
  sessionName: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  turnUsage?: TurnUsage;
  iteration?: number;
}

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkflowState {
  id: string;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  steps: Record<string, WorkflowStepState>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
