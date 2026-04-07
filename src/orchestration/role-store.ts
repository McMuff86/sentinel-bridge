import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getStateDir } from '../state-dir.js';
import type { AgentRole } from './roles.js';

interface RoleStoreData {
  version: 1;
  roles: Record<string, AgentRole>;
}

function getDefaultRoleStorePath(): string {
  return `${getStateDir()}/roles.json`;
}

export class RoleStore {
  private readonly path: string;

  constructor(path = getDefaultRoleStorePath()) {
    this.path = path;
  }

  load(): RoleStoreData {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RoleStoreData;
      if (!parsed || parsed.version !== 1 || typeof parsed.roles !== 'object') {
        return { version: 1, roles: {} };
      }
      return parsed;
    } catch {
      const tmpPath = this.path + '.tmp';
      if (existsSync(tmpPath)) {
        try {
          const raw = readFileSync(tmpPath, 'utf8');
          const parsed = JSON.parse(raw) as RoleStoreData;
          if (parsed?.version === 1 && typeof parsed.roles === 'object') {
            renameSync(tmpPath, this.path);
            return parsed;
          }
        } catch {
          // Temp file also corrupt — start fresh
        }
      }
      return { version: 1, roles: {} };
    }
  }

  save(data: RoleStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = this.path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, this.path);
  }

  upsert(role: AgentRole): void {
    const data = this.load();
    data.roles[role.id] = role;
    this.save(data);
  }

  get(id: string): AgentRole | undefined {
    return this.load().roles[id];
  }

  delete(id: string): void {
    const data = this.load();
    if (!(id in data.roles)) return;
    delete data.roles[id];
    this.save(data);
  }

  list(): AgentRole[] {
    return Object.values(this.load().roles);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}
