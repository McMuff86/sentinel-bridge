import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ContextEventType = 'context_set' | 'context_deleted' | 'context_cleared';

export interface ContextEvent {
  ts: string;
  type: ContextEventType;
  workspace: string;
  key?: string;
  setBy: string;
}

function getDefaultContextEventsDir(): string {
  const home = process?.env?.HOME ?? '/tmp';
  return join(home, '.openclaw', 'extensions', 'sentinel-bridge', 'state', 'context-events');
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const MAX_EVENTS = 1000;

export class ContextEventStore {
  private readonly dir: string;
  private readonly maxEvents: number;

  constructor(dir = getDefaultContextEventsDir(), maxEvents = MAX_EVENTS) {
    this.dir = dir;
    this.maxEvents = maxEvents;
  }

  appendEvent(event: ContextEvent): void {
    const filePath = this.pathFor(event.workspace);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    this.pruneIfNeeded(filePath);
  }

  listEvents(workspace: string, limit = 20): ContextEvent[] {
    const filePath = this.pathFor(workspace);
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }

    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const events: ContextEvent[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as ContextEvent);
      } catch {
        // Skip malformed JSONL lines
      }
    }
    return events;
  }

  clearEvents(workspace: string): void {
    rmSync(this.pathFor(workspace), { force: true });
  }

  private pathFor(workspace: string): string {
    return join(this.dir, `${sanitiseFileName(workspace)}.jsonl`);
  }

  private pruneIfNeeded(filePath: string): void {
    if (this.maxEvents <= 0) return;
    try {
      const lines = readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean);
      if (lines.length > this.maxEvents) {
        const kept = lines.slice(-this.maxEvents);
        writeFileSync(filePath, kept.join('\n') + '\n', 'utf8');
      }
    } catch {
      // Best-effort pruning
    }
  }
}
