import type { EngineKind, TurnUsage } from '../types.js';

export interface WorkflowStepDefinition {
  id: string;
  sessionName: string;
  role?: string;
  task: string;
  dependsOn?: string[];
  engine?: EngineKind;
  model?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  workspace: string;
  steps: WorkflowStepDefinition[];
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
}

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowState {
  id: string;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  steps: Record<string, WorkflowStepState>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
