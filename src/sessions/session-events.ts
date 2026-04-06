import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const MAX_EVENTS_PER_SESSION = 1000;

export class SessionEventStore {
  private readonly dir: string;
  private readonly maxEvents: number;

  constructor(dir = getDefaultEventsDir(), maxEvents = MAX_EVENTS_PER_SESSION) {
    this.dir = dir;
    this.maxEvents = maxEvents;
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.pathFor(event.sessionName);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    this.pruneIfNeeded(filePath);
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
    const events: SessionEvent[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed JSONL lines rather than crashing
      }
    }
    return events;
  }

  clearEvents(name: string): void {
    rmSync(this.pathFor(name), { force: true });
  }

  private pathFor(name: string): string {
    return join(this.dir, `${sanitiseFileName(name)}.jsonl`);
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
      // Best-effort pruning — don't fail the append
    }
  }
}
