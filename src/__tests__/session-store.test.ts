import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../sessions/session-store.js';
import type { SessionInfo } from '../types.js';

function makeSession(name: string): SessionInfo {
  const now = new Date();
  return {
    id: 'test-id-' + name,
    name,
    engine: 'claude',
    model: 'claude-opus-4-6',
    status: 'active',
    createdAt: now,
    costUsd: 0,
    tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
    cwd: '/tmp',
    engineState: 'running',
    engineSessionId: null,
    lastTouchedAt: now,
    activity: {
      phase: 'idle',
      lastAction: 'start',
      updatedAt: now,
      lastPromptPreview: null,
      lastResponsePreview: null,
      isRehydrated: false,
    },
    turnCount: 0,
  };
}

describe('SessionStore', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-store-'));
    storePath = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses atomic writes (temp file + rename)', () => {
    const store = new SessionStore(storePath);
    store.upsert(makeSession('atomic-test'));

    // Main file should exist with valid data
    const raw = readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.sessions['atomic-test']).toBeDefined();

    // No leftover .tmp file
    expect(() => readFileSync(storePath + '.tmp', 'utf8')).toThrow();
  });

  it('recovers from .tmp file when main file is missing', () => {
    // Simulate a crash: only .tmp exists
    const tmpData = {
      version: 1,
      sessions: {
        'recovered': {
          id: 'r1',
          name: 'recovered',
          engine: 'claude',
          model: 'claude-opus-4-6',
          status: 'active',
          createdAt: new Date().toISOString(),
          costUsd: 0,
          tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 },
          cwd: null,
          engineState: 'running',
          engineSessionId: null,
          lastTouchedAt: new Date().toISOString(),
          turnCount: 0,
        },
      },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath + '.tmp', JSON.stringify(tmpData), 'utf8');

    const store = new SessionStore(storePath);
    const data = store.load();
    expect(data.sessions['recovered']).toBeDefined();
  });

  it('returns empty store when both main and .tmp are missing', () => {
    const store = new SessionStore(storePath);
    const data = store.load();
    expect(data.version).toBe(1);
    expect(Object.keys(data.sessions)).toHaveLength(0);
  });

  it('ignores corrupt .tmp file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath + '.tmp', 'not valid json{{{', 'utf8');

    const store = new SessionStore(storePath);
    const data = store.load();
    expect(data.version).toBe(1);
    expect(Object.keys(data.sessions)).toHaveLength(0);
  });

  it('survives rapid sequential upserts without data loss', () => {
    const store = new SessionStore(storePath);
    const count = 50;

    for (let i = 0; i < count; i++) {
      store.upsert(makeSession(`rapid-${i}`));
    }

    const all = store.list();
    expect(all).toHaveLength(count);

    for (let i = 0; i < count; i++) {
      const session = store.get(`rapid-${i}`);
      expect(session).toBeDefined();
      expect(session!.name).toBe(`rapid-${i}`);
    }

    const raw = readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.sessions)).toHaveLength(count);
  });

  it('preserves existing sessions when upserting a new one', () => {
    const store = new SessionStore(storePath);
    store.upsert(makeSession('first'));
    store.upsert(makeSession('second'));
    store.upsert(makeSession('third'));

    const first = store.get('first');
    expect(first).toBeDefined();
    expect(first!.name).toBe('first');

    expect(store.list()).toHaveLength(3);
  });

  it('round-trips all SessionInfo fields through persist/load', () => {
    const store = new SessionStore(storePath);
    const session = makeSession('roundtrip');
    session.costUsd = 1.234;
    session.tokenCount = { input: 100, output: 50, cachedInput: 25, total: 175 };
    session.turnCount = 7;
    session.role = 'architect';
    session.lastError = 'test error';

    store.upsert(session);
    const loaded = store.get('roundtrip')!;

    expect(loaded.costUsd).toBe(1.234);
    expect(loaded.tokenCount).toEqual({ input: 100, output: 50, cachedInput: 25, total: 175 });
    expect(loaded.turnCount).toBe(7);
    expect(loaded.role).toBe('architect');
    expect(loaded.lastError).toBe('test error');
    expect(loaded.engine).toBe('claude');
    expect(loaded.model).toBe('claude-opus-4-6');
  });

  it('delete removes only the target session', () => {
    const store = new SessionStore(storePath);
    store.upsert(makeSession('keep'));
    store.upsert(makeSession('remove'));

    store.delete('remove');

    expect(store.get('remove')).toBeUndefined();
    expect(store.get('keep')).toBeDefined();
    expect(store.list()).toHaveLength(1);
  });
});
