import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getStateDir } from '../state-dir.js';
import type { EmbeddingRecord } from './knn-router.js';

function getDefaultPath(): string {
  return join(getStateDir(), 'embeddings.jsonl');
}

const MAX_RECORDS = 10000;

/**
 * JSONL-backed persistence for embedding records.
 *
 * Appends new records line-by-line for performance, and supports
 * periodic compaction to keep the file under MAX_RECORDS entries.
 */
export class EmbeddingStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultPath();
  }

  append(record: EmbeddingRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
  }

  load(): EmbeddingRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const contents = readFileSync(this.filePath, 'utf8');
      const lines = contents.split('\n').filter(l => l.trim());
      const records: EmbeddingRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch { /* skip corrupt lines */ }
      }
      // Return only last MAX_RECORDS
      return records.slice(-MAX_RECORDS);
    } catch {
      return [];
    }
  }

  /**
   * Compact: atomically rewrite file with only the last MAX_RECORDS entries.
   */
  compact(records: EmbeddingRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    const data = records.slice(-MAX_RECORDS).map(r => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(tmpPath, data, 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}
