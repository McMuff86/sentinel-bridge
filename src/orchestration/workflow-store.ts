import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getStateDir } from '../state-dir.js';
import type { WorkflowState } from './workflow-types.js';

interface WorkflowStoreData {
  version: 1;
  workflows: Record<string, WorkflowState>;
}

function getDefaultWorkflowStorePath(): string {
  return `${getStateDir()}/workflows.json`;
}

export class WorkflowStore {
  private readonly path: string;

  constructor(path = getDefaultWorkflowStorePath()) {
    this.path = path;
  }

  load(): WorkflowStoreData {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as WorkflowStoreData;
      if (!parsed || parsed.version !== 1 || typeof parsed.workflows !== 'object') {
        return { version: 1, workflows: {} };
      }
      return parsed;
    } catch {
      const tmpPath = this.path + '.tmp';
      if (existsSync(tmpPath)) {
        try {
          const raw = readFileSync(tmpPath, 'utf8');
          const parsed = JSON.parse(raw) as WorkflowStoreData;
          if (parsed?.version === 1 && typeof parsed.workflows === 'object') {
            renameSync(tmpPath, this.path);
            return parsed;
          }
        } catch {
          // Start fresh
        }
      }
      return { version: 1, workflows: {} };
    }
  }

  save(data: WorkflowStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = this.path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, this.path);
  }

  upsert(workflow: WorkflowState): void {
    const data = this.load();
    data.workflows[workflow.id] = workflow;
    this.save(data);
  }

  get(id: string): WorkflowState | undefined {
    return this.load().workflows[id];
  }

  list(): WorkflowState[] {
    return Object.values(this.load().workflows);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}
