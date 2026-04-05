import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EngineKind } from '../types.js';

export type SessionEventType =
  | 'session_started'
  | 'session_rehydrated'
  | 'message_sent'
  | 'message_completed'
  | 'message_failed'
  | 'status_checked'
  | 'compact_started'
  | 'compact_completed'
  | 'session_stopped';

export interface SessionEvent {
  ts: string;
  type: SessionEventType;
  engine: EngineKind;
  sessionName: string;
  preview?: string;
  error?: string;
}

function getDefaultEventsDir(): string {
  const home = process?.env?.HOME ?? '/tmp';
  return join(home, '.openclaw', 'extensions', 'sentinel-bridge', 'state', 'events');
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class SessionEventStore {
  private readonly dir: string;

  constructor(dir = getDefaultEventsDir()) {
    this.dir = dir;
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.pathFor(event.sessionName);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
  }

  listEvents(name: string, limit = 20): SessionEvent[] {
    const filePath = this.pathFor(name);
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }

    const tail = limit > 0 ? lines.slice(-limit) : lines;
    return tail.map((line) => JSON.parse(line) as SessionEvent);
  }

  clearEvents(name: string): void {
    rmSync(this.pathFor(name), { force: true });
  }

  private pathFor(name: string): string {
    return join(this.dir, `${sanitiseFileName(name)}.jsonl`);
  }
}
