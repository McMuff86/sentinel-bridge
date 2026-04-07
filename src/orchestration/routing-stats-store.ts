import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getStateDir } from '../state-dir.js';
import type { RoutingStats } from './adaptive-router.js';

function getDefaultPath(): string {
  return join(getStateDir(), 'routing-stats.json');
}

export class RoutingStatsStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultPath();
  }

  save(stats: RoutingStats[]): void {
    const data = JSON.stringify({ version: 1, stats }, null, 2) + '\n';
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, data, 'utf8');
    renameSync(tmpPath, this.filePath);
  }

  load(): RoutingStats[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.stats)) {
        return parsed.stats;
      }
      return [];
    } catch {
      return [];
    }
  }
}
