import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ContextStore, validateContextKey } from '../orchestration/context-store.js';
import { ContextEventStore } from '../orchestration/context-events.js';

describe('ContextStore', () => {
  let dir: string;
  let store: ContextStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-ctx-'));
    store = new ContextStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('set and get', () => {
    it('should store and retrieve a value', () => {
      store.set('ws1', 'greeting', 'hello', 'agent-a');
      const entry = store.get('ws1', 'greeting');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('greeting');
      expect(entry!.value).toBe('hello');
      expect(entry!.setBy).toBe('agent-a');
      expect(entry!.updatedAt).toBeDefined();
    });

    it('should store complex JSON values', () => {
      const complex = { nested: { arr: [1, 2, 3], flag: true } };
      store.set('ws1', 'data', complex, 'agent-a');
      const entry = store.get('ws1', 'data');
      expect(entry!.value).toEqual(complex);
    });

    it('should overwrite existing keys', () => {
      store.set('ws1', 'key1', 'v1', 'agent-a');
      store.set('ws1', 'key1', 'v2', 'agent-b');
      const entry = store.get('ws1', 'key1');
      expect(entry!.value).toBe('v2');
      expect(entry!.setBy).toBe('agent-b');
    });

    it('should return undefined for missing keys', () => {
      expect(store.get('ws1', 'missing')).toBeUndefined();
    });

    it('should reject non-JSON-serializable values', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(() => store.set('ws1', 'bad', circular, 'agent-a')).toThrow('not JSON-serializable');
    });
  });

  describe('workspace isolation', () => {
    it('should keep workspaces separate', () => {
      store.set('ws1', 'key', 'value-a', 'agent-a');
      store.set('ws2', 'key', 'value-b', 'agent-b');

      expect(store.get('ws1', 'key')!.value).toBe('value-a');
      expect(store.get('ws2', 'key')!.value).toBe('value-b');
    });

    it('should not affect other workspaces on clear', () => {
      store.set('ws1', 'key', 'v1', 'a');
      store.set('ws2', 'key', 'v2', 'b');
      store.clear('ws1');

      expect(store.get('ws1', 'key')).toBeUndefined();
      expect(store.get('ws2', 'key')!.value).toBe('v2');
    });
  });

  describe('cross-session visibility', () => {
    it('should allow one session to read values set by another', () => {
      store.set('shared', 'result', 42, 'session-writer');
      const entry = store.get('shared', 'result');
      expect(entry!.value).toBe(42);
      expect(entry!.setBy).toBe('session-writer');
    });
  });

  describe('list', () => {
    it('should return all entries in a workspace', () => {
      store.set('ws1', 'a', 1, 'agent');
      store.set('ws1', 'b', 2, 'agent');
      store.set('ws1', 'c', 3, 'agent');
      const entries = store.list('ws1');
      expect(entries).toHaveLength(3);
      const keys = entries.map(e => e.key).sort();
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('should return empty array for non-existent workspace', () => {
      expect(store.list('nope')).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should remove a key', () => {
      store.set('ws1', 'key', 'val', 'agent');
      expect(store.delete('ws1', 'key')).toBe(true);
      expect(store.get('ws1', 'key')).toBeUndefined();
    });

    it('should return false for missing key', () => {
      expect(store.delete('ws1', 'nope')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      store.set('ws1', 'a', 1, 'agent');
      store.set('ws1', 'b', 2, 'agent');
      store.clear('ws1');
      expect(store.list('ws1')).toEqual([]);
    });
  });

  describe('atomic writes', () => {
    it('should use temp file + rename pattern', () => {
      store.set('ws1', 'test', 'value', 'agent');

      // Main file should exist with valid data
      const files = readFileSync(join(dir, 'ws1.json'), 'utf8');
      const data = JSON.parse(files);
      expect(data.version).toBe(1);
      expect(data.entries['test']).toBeDefined();

      // No leftover .tmp file
      expect(() => readFileSync(join(dir, 'ws1.json.tmp'), 'utf8')).toThrow();
    });

    it('should recover from .tmp file when main is missing', () => {
      const tmpData = {
        version: 1,
        workspace: 'ws1',
        entries: {
          recovered: { key: 'recovered', value: 'yes', setBy: 'test', updatedAt: new Date().toISOString() },
        },
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ws1.json.tmp'), JSON.stringify(tmpData), 'utf8');

      const entry = store.get('ws1', 'recovered');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe('yes');
    });

    it('should return empty for corrupt files', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ws1.json'), 'not valid json{{{', 'utf8');
      expect(store.list('ws1')).toEqual([]);
    });
  });
});

describe('validateContextKey', () => {
  it('should accept valid keys', () => {
    expect(() => validateContextKey('simple')).not.toThrow();
    expect(() => validateContextKey('my-key')).not.toThrow();
    expect(() => validateContextKey('my_key')).not.toThrow();
    expect(() => validateContextKey('step1.output')).not.toThrow();
    expect(() => validateContextKey('ns:key')).not.toThrow();
    expect(() => validateContextKey('key with spaces')).not.toThrow();
  });

  it('should reject empty keys', () => {
    expect(() => validateContextKey('')).toThrow('Invalid context key');
  });

  it('should reject keys starting with non-alphanumeric', () => {
    expect(() => validateContextKey('.dot-start')).toThrow('Invalid context key');
    expect(() => validateContextKey('-dash-start')).toThrow('Invalid context key');
  });

  it('should reject keys exceeding 128 chars', () => {
    const long = 'a' + 'x'.repeat(128);
    expect(() => validateContextKey(long)).toThrow('Invalid context key');
  });
});

describe('ContextEventStore', () => {
  let dir: string;
  let eventStore: ContextEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-ctx-evt-'));
    eventStore = new ContextEventStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should append and list events', () => {
    eventStore.appendEvent({
      ts: new Date().toISOString(),
      type: 'context_set',
      workspace: 'ws1',
      key: 'k1',
      setBy: 'agent',
    });
    eventStore.appendEvent({
      ts: new Date().toISOString(),
      type: 'context_set',
      workspace: 'ws1',
      key: 'k2',
      setBy: 'agent',
    });

    const events = eventStore.listEvents('ws1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('context_set');
    expect(events[0].key).toBe('k1');
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      eventStore.appendEvent({
        ts: new Date().toISOString(),
        type: 'context_set',
        workspace: 'ws1',
        key: `k${i}`,
        setBy: 'agent',
      });
    }

    const events = eventStore.listEvents('ws1', 3);
    expect(events).toHaveLength(3);
    expect(events[0].key).toBe('k7');
  });

  it('should return empty for non-existent workspace', () => {
    expect(eventStore.listEvents('nope')).toEqual([]);
  });

  it('should clear events for a workspace', () => {
    eventStore.appendEvent({
      ts: new Date().toISOString(),
      type: 'context_set',
      workspace: 'ws1',
      key: 'k1',
      setBy: 'agent',
    });
    eventStore.clearEvents('ws1');
    expect(eventStore.listEvents('ws1')).toEqual([]);
  });
});
